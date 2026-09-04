import { fork } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';

const WORKER = fileURLToPath(new URL('./sharp-provider-worker.js', import.meta.url));
const CONFIGURED_POOL_SIZE = Number(process.env.MOCHIMONO_PROVIDER_SHARP_WORKERS) || 0;
const POOL_SIZE = Math.max(1, Math.min(8, CONFIGURED_POOL_SIZE || Math.ceil(Math.max(1, availableParallelism()) / 2)));
const JOB_TIMEOUT_MS = 25_000;
const slots = new Set();
const queue = [];
let nextId = 0;
let closing = false;

function exitDescription(code, signal) {
  if (signal) return `signal ${signal}`;
  if (!Number.isInteger(code)) return 'unknown exit';
  const unsigned = code >>> 0;
  return process.platform === 'win32'
    ? `${code} (0x${unsigned.toString(16).padStart(8, '0')})`
    : String(code);
}

function workerError(message, code = 'SHARP_WORKER_ERROR') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function removeSlot(slot, error = null) {
  if (!slot || slot.dead) return;
  slot.dead = true;
  slots.delete(slot);
  if (slot.timer) clearTimeout(slot.timer);
  slot.timer = null;
  const job = slot.job;
  slot.job = null;
  if (job && error) job.reject(error);
  if (!closing) queueMicrotask(pump);
}

function createSlot() {
  const child = fork(WORKER, [], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true,
    serialization: 'advanced'
  });
  const slot = { child, job: null, timer: null, dead: false };
  slots.add(slot);

  child.on('message', message => {
    const job = slot.job;
    if (!job || Number(message?.id) !== job.id) return;
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
    slot.job = null;

    if (message.ok) {
      const data = Buffer.isBuffer(message.data) ? message.data : Buffer.from(message.data || []);
      job.resolve({
        data,
        info: {
          width: Number(message.info?.width) || 0,
          height: Number(message.info?.height) || 0
        }
      });
    } else {
      const error = workerError(String(message.error || 'Sharp thumbnail failed'), String(message.code || 'SHARP_THUMBNAIL_FAILED'));
      job.reject(error);
    }
    pump();
  });

  child.on('error', error => {
    removeSlot(slot, workerError(`Sharp thumbnail worker failed: ${error.message}`, error.code || 'SHARP_WORKER_ERROR'));
  });

  child.on('exit', (code, signal) => {
    if (closing || slot.dead) return removeSlot(slot);
    removeSlot(slot, workerError(`Sharp thumbnail worker crashed with ${exitDescription(code, signal)}`, 'SHARP_WORKER_CRASH'));
  });
  return slot;
}

function run(slot, job) {
  slot.job = job;
  slot.timer = setTimeout(() => {
    const error = workerError('Sharp thumbnail worker timed out', 'SHARP_WORKER_TIMEOUT');
    try { slot.child.kill(); } catch {}
    removeSlot(slot, error);
  }, JOB_TIMEOUT_MS);
  slot.timer.unref?.();
  try {
    slot.child.send({ type: 'thumbnail', id: job.id, input: job.input, edge: job.edge });
  } catch (error) {
    removeSlot(slot, workerError(`Could not start Sharp thumbnail job: ${error.message}`, error.code || 'SHARP_WORKER_ERROR'));
  }
}

function pump() {
  if (closing || !queue.length) return;
  while (queue.length) {
    let slot = [...slots].find(item => !item.dead && !item.job);
    if (!slot && slots.size < POOL_SIZE) slot = createSlot();
    if (!slot) return;
    run(slot, queue.shift());
  }
}

function isolatedThumbnail(input, edge = 768) {
  return new Promise((resolve, reject) => {
    queue.push({ id: ++nextId, input: String(input), edge: Number(edge) || 768, resolve, reject });
    pump();
  });
}

function sharp(input) {
  let edge = 768;
  const chain = {
    rotate() { return chain; },
    resize(options = {}) {
      edge = Math.max(1, Number(options.width) || Number(options.height) || edge);
      return chain;
    },
    webp() { return chain; },
    toBuffer() { return isolatedThumbnail(input, edge); }
  };
  return chain;
}

sharp.concurrency = () => 1;
sharp.cache = () => ({ memory: 0, files: 0, items: 0 });

process.once('exit', () => {
  closing = true;
  for (const slot of slots) {
    slot.dead = true;
    try { slot.child.kill(); } catch {}
  }
});

export default sharp;
