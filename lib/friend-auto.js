import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_DIR, api, currentJob } from './agent-context.js';

const FRIEND_ORIGIN = 'http://127.0.0.1:8644';
const FIRST_RUN_MS = 2 * 60_000;
const INTERVAL_MS = 15 * 60_000;
const MIN_USEFUL_FREE = 10 * 1024 * 1024;
const CAPACITY_CHANGE = 32 * 1024 * 1024;
const lastLimitedFree = new Map();
let running = false;

async function request(path, options = {}) {
  const response = await fetch(`${FRIEND_ORIGIN}${path}`, {
    signal:AbortSignal.timeout(12_000),
    ...options,
    headers:{ 'content-type':'application/json', ...(options.headers || {}) }
  });
  if (!response.ok) throw Object.assign(new Error(`${response.status} ${response.statusText}`), { status:response.status });
  return response.json().catch(() => ({}));
}

async function backgroundPaused() {
  try {
    const value = JSON.parse(await readFile(join(CONFIG_DIR, 'protection.json'), 'utf8'));
    return value?.background === 'paused';
  } catch { return false; }
}

function hasFreshCapacity(target) {
  const free = Math.max(0, Number(target.storage?.freeBytes) || 0);
  if (free < MIN_USEFUL_FREE) return false;
  if (!Number(target.lastCapacitySkippedBytes)) {
    lastLimitedFree.delete(target.id);
    return true;
  }
  const previous = lastLimitedFree.get(target.id);
  lastLimitedFree.set(target.id, free);
  return previous == null ? false : free >= previous + CAPACITY_CHANGE;
}

async function tick() {
  if (running || currentJob()?.status === 'running' || await backgroundPaused()) return;
  running = true;
  try {
    const data = await request('/local/friend-backups');
    for (const target of data.backups || []) {
      if (!target.storage?.online || !hasFreshCapacity(target)) continue;
      const plan = await api(`/api/protection/plan/${encodeURIComponent(target.id)}?limit=1`).catch(() => null);
      if (!plan?.objects?.length) continue;
      if (currentJob()?.status === 'running') return;
      const response = await fetch(`${FRIEND_ORIGIN}/local/friend-backups/${encodeURIComponent(target.id)}/update`, {
        method:'POST',
        signal:AbortSignal.timeout(12_000)
      }).catch(() => null);
      if (response?.ok) return;
    }
  } catch {}
  finally { running = false; }
}

const first = setTimeout(() => tick().catch(() => {}), FIRST_RUN_MS);
first.unref?.();
const timer = setInterval(() => tick().catch(() => {}), INTERVAL_MS);
timer.unref?.();
