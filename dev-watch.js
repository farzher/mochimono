import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const pollMs = 5000;

let dev = null;
let stopping = false;
let restarting = false;
let checking = false;
let timer = null;
let lastNotice = '';

function git(args, { inherit = false } = {}) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: inherit ? undefined : 'utf8',
    stdio: inherit ? 'inherit' : 'pipe',
    windowsHide: true
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = inherit ? '' : String(result.stderr || result.stdout || '').trim();
    throw new Error(detail || `git ${args.join(' ')} failed with exit code ${result.status}`);
  }
  return inherit ? '' : String(result.stdout || '').trim();
}

function isAncestor(ancestor, descendant) {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
    cwd: root,
    stdio: 'ignore',
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error('Could not compare local and remote Git history.');
}

function notice(key, text) {
  if (lastNotice === key) return;
  lastNotice = key;
  console.log(text);
}

function workingTreeIsClean() {
  return !git(['status', '--porcelain']);
}

function ensureDeps() {
  const result = spawnSync(process.execPath, [join(root, 'ensure-deps.js')], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: false
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Dependency setup failed with exit code ${result.status}`);
}

function startDev() {
  const child = spawn(process.execPath, [join(root, 'dev.js')], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    windowsHide: false
  });
  dev = child;

  child.on('exit', (code, signal) => {
    if (dev === child) dev = null;
    if (stopping || restarting) return;
    const why = signal ? `signal ${signal}` : `exit code ${code ?? 1}`;
    console.error(`[dev] Mochimono stopped unexpectedly (${why}).`);
    void shutdown(code || 1);
  });
}

function stopDev() {
  const child = dev;
  if (!child || child.exitCode !== null) return Promise.resolve();

  return new Promise(resolve => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(fallback);
      resolve();
    };
    const fallback = setTimeout(done, 2000);
    fallback.unref();
    child.once('exit', done);

    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      });
    } else {
      child.kill('SIGTERM');
    }
  });
}

async function pullUpdate({ requireCurrent = false } = {}) {
  git(['fetch', '--quiet', 'origin', 'main']);

  const local = git(['rev-parse', 'HEAD']);
  const remote = git(['rev-parse', 'origin/main']);
  if (local === remote) {
    lastNotice = '';
    return false;
  }

  if (isAncestor(remote, local)) {
    // Local commits are ahead of GitHub. There is nothing to pull.
    lastNotice = '';
    return false;
  }

  if (!isAncestor(local, remote)) {
    const message = 'origin/main has diverged from the local branch; automatic update is unsafe.';
    if (requireCurrent) throw new Error(`${message} Refusing to start an unverified dev server.`);
    notice(`diverged:${remote}`, `[git] ${message}`);
    return false;
  }

  if (!workingTreeIsClean()) {
    const message = 'GitHub has a newer version, but the working tree has local changes.';
    if (requireCurrent) throw new Error(`${message} Refusing to start the outdated dev server.`);
    notice(`dirty:${remote}`, `[git] ${message} Skipping automatic pull.`);
    return false;
  }

  console.log(`[git] GitHub update detected: ${local.slice(0, 7)} -> ${remote.slice(0, 7)}`);
  git(['merge', '--ff-only', 'origin/main'], { inherit: true });
  lastNotice = '';
  return true;
}

async function checkForUpdate() {
  if (checking || stopping || restarting) return;
  checking = true;
  try {
    if (!(await pullUpdate())) return;

    restarting = true;
    console.log('[dev] Restarting Mochimono...');
    await stopDev();
    try {
      ensureDeps();
      if (!stopping) startDev();
      console.log('[dev] Restart complete.');
    } catch (error) {
      console.error(`[dev] Restart failed: ${error.message}`);
      await shutdown(1);
    }
  } catch (error) {
    notice(`error:${error.message}`, `[git] Update check failed: ${error.message}`);
  } finally {
    restarting = false;
    checking = false;
  }
}

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  if (timer) clearInterval(timer);
  await stopDev();
  process.exit(code);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

try {
  await pullUpdate({ requireCurrent: true });
} catch (error) {
  console.error(`[git] Startup update check failed: ${error.message}`);
  console.error('[dev] Mochimono was not started. Resolve the Git state and run npm run dev again.');
  process.exit(1);
}

try {
  ensureDeps();
} catch (error) {
  console.error(`[dev] ${error.message}`);
  process.exit(1);
}

startDev();
timer = setInterval(() => void checkForUpdate(), pollMs);
timer.unref();
