import { execFile } from 'node:child_process';
import { cpus, platform } from 'node:os';
import { promisify } from 'node:util';
import { currentJob, settings } from './agent-context.js';

const exec = promisify(execFile);
const IDLE_AFTER_MS = 60_000;
const CPU_LIMIT = .18;
const INPUT_PROBE_MS = 5_000;
const WAIT_POLL_MS = 500;

let lastActivity = Date.now();
let inputIdleMs = null;
let inputSource = 'activity';
let systemCpuLoad = 1;
let previousCpu = cpuSnapshot();
let probing = false;

function cpuSnapshot() {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    idle += Number(cpu.times.idle) || 0;
    total += Object.values(cpu.times).reduce((sum, value) => sum + (Number(value) || 0), 0);
  }
  return { idle, total };
}

function sampleCpu() {
  const next = cpuSnapshot();
  const idle = next.idle - previousCpu.idle;
  const total = next.total - previousCpu.total;
  previousCpu = next;
  if (total > 0) systemCpuLoad = Math.max(0, Math.min(1, 1 - idle / total));
}

function parseWindowsIdle(value) {
  const text = String(value || '');
  const lines = text.split(/\r?\n/).filter(Boolean);
  const headerIndex = lines.findIndex(line => /IDLE\s+TIME/i.test(line) && /LOGON\s+TIME/i.test(line));
  if (headerIndex < 0) return null;
  const header = lines[headerIndex];
  const start = header.search(/IDLE\s+TIME/i);
  const end = header.search(/LOGON\s+TIME/i);
  const username = String(process.env.USERNAME || '').toLowerCase();
  const rows = lines.slice(headerIndex + 1);
  const row = rows.find(line => line.trimStart().startsWith('>')) ||
    rows.find(line => username && line.toLowerCase().includes(username)) || rows[0];
  if (!row || start < 0) return null;
  const idle = row.slice(start, end > start ? end : undefined).trim().toLowerCase();
  if (!idle || idle === 'none' || idle === '.') return 0;
  let match = idle.match(/^(\d+)\+(\d+):(\d+)$/);
  if (match) return (Number(match[1]) * 24 * 60 + Number(match[2]) * 60 + Number(match[3])) * 60_000;
  match = idle.match(/^(\d+):(\d+)$/);
  if (match) return (Number(match[1]) * 60 + Number(match[2])) * 60_000;
  if (/^\d+$/.test(idle)) return Number(idle) * 60_000;
  return null;
}

async function probeInputIdle() {
  if (probing) return;
  probing = true;
  try {
    if (platform() === 'win32') {
      const { stdout } = await exec('query.exe', ['user'], { windowsHide: true, timeout: 2_000, maxBuffer: 64 * 1024 });
      const idle = parseWindowsIdle(stdout);
      if (idle != null) {
        inputIdleMs = idle;
        inputSource = 'windows-session';
      }
      return;
    }
    if (platform() === 'darwin') {
      const { stdout } = await exec('ioreg', ['-c', 'IOHIDSystem'], { timeout: 2_000, maxBuffer: 256 * 1024 });
      const match = String(stdout || '').match(/"HIDIdleTime"\s*=\s*(\d+)/);
      if (match) {
        inputIdleMs = Number(match[1]) / 1_000_000;
        inputSource = 'mac-input';
      }
      return;
    }
    if (platform() === 'linux' && process.env.XDG_SESSION_ID) {
      const { stdout } = await exec('loginctl', ['show-session', process.env.XDG_SESSION_ID, '-p', 'IdleHint'], { timeout: 2_000, maxBuffer: 16 * 1024 });
      const match = String(stdout || '').match(/IdleHint=(yes|no)/i);
      if (match) {
        inputIdleMs = match[1].toLowerCase() === 'yes' ? IDLE_AFTER_MS : 0;
        inputSource = 'linux-session';
      }
    }
  } catch {
    // CPU plus Mochimono activity is the portable fallback when the OS cannot
    // provide session idle time.
  } finally {
    probing = false;
  }
}

const cpuTimer = setInterval(sampleCpu, 1_000);
const inputTimer = setInterval(probeInputIdle, INPUT_PROBE_MS);
cpuTimer.unref?.();
inputTimer.unref?.();
probeInputIdle().catch(() => {});

export function noteBackgroundActivity() {
  lastActivity = Date.now();
}

export function backgroundWorkStatus() {
  const mode = settings.thumbnailMode;
  const localIdleMs = Math.max(0, Date.now() - lastActivity);
  const idleMs = inputIdleMs == null ? localIdleMs : Math.min(inputIdleMs, localIdleMs);
  if (mode === 'max') return { mode, allowed: true, waiting: false, reason: '', idleMs, cpuLoad: systemCpuLoad, inputSource };
  if (mode === 'off') return { mode, allowed: false, waiting: false, reason: 'on-demand', idleMs, cpuLoad: systemCpuLoad, inputSource };
  const inputIdle = idleMs >= IDLE_AFTER_MS;
  const cpuIdle = systemCpuLoad <= CPU_LIMIT;
  return {
    mode,
    allowed: inputIdle && cpuIdle,
    waiting: !inputIdle || !cpuIdle,
    reason: !inputIdle ? 'active' : !cpuIdle ? 'busy' : '',
    idleMs,
    cpuLoad: systemCpuLoad,
    inputSource
  };
}

export const backgroundWorkAllowed = () => backgroundWorkStatus().allowed;

export async function waitForBackgroundWork() {
  while (currentJob()?.background && settings.thumbnailMode === 'idle' && !backgroundWorkAllowed()) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, WAIT_POLL_MS));
  }
}
