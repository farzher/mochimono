import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';

const WORKERS = Math.max(1, Math.min(2, Math.ceil(availableParallelism() / 4)));
const slots = Array.from({ length: WORKERS }, () => ({ worker: null, busy: null }));
const queue = [];
let nextId = 0;

function rejectSlot(slot, error) {
  if (slot.busy) slot.busy.reject(error);
  slot.busy = null;
  slot.worker = null;
  pump();
}

function startWorker(slot) {
  if (slot.worker) return slot.worker;
  const worker = new Worker(new URL('./heic-worker.js', import.meta.url));
  worker.unref?.();
  worker.on('message', message => {
    const job = slot.busy;
    if (!job || Number(message?.id) !== job.id) return;
    slot.busy = null;
    if (message.ok) job.resolve({ data: Buffer.from(message.data), info: message.info || {} });
    else job.reject(new Error(message.error || 'HEIC decode failed'));
    pump();
  });
  worker.on('error', error => rejectSlot(slot, error));
  worker.on('exit', code => {
    if (slot.worker !== worker) return;
    const error = code === 0 ? new Error('HEIC decoder stopped') : new Error(`HEIC decoder exited with ${code}`);
    rejectSlot(slot, error);
  });
  slot.worker = worker;
  return worker;
}

function pump() {
  for (const slot of slots) {
    if (slot.busy || !queue.length) continue;
    const job = queue.shift();
    slot.busy = job;
    try {
      startWorker(slot).postMessage({ id: job.id, path: job.path, edge: job.edge, quality: job.quality, effort: job.effort });
    } catch (error) {
      rejectSlot(slot, error);
    }
  }
}

export function decodeHeic(path, options = {}) {
  return new Promise((resolve, reject) => {
    queue.push({
      id: ++nextId,
      path: String(path || ''),
      edge: Number(options.edge) || 0,
      quality: Number(options.quality) || 82,
      effort: Number(options.effort) || 2,
      resolve,
      reject
    });
    pump();
  });
}
