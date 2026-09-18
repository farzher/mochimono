import { Worker } from 'node:worker_threads';

// HEIC decode can temporarily consume a lot of CPU and memory. Running two
// decoders at once makes the browser compete with decode work for no useful UI
// benefit, so keep one decoder and let interactive viewer jobs jump the queue.
const WORKERS = 1;
const DECODE_TIMEOUT_MS = 30_000;
const slots = Array.from({ length: WORKERS }, () => ({ worker: null, busy: null }));
const queue = [];
let nextId = 0;

function rejectSlot(slot, error) {
  if (slot.busy) {
    clearTimeout(slot.busy.timer);
    slot.busy.reject(error);
  }
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
    clearTimeout(job.timer);
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
      const worker=startWorker(slot);
      worker.postMessage({
        id:job.id,
        path:job.path,
        edge:job.edge,
        quality:job.quality,
        effort:job.effort,
        portable:job.portable
      });
      job.timer=setTimeout(() => {
        if(slot.busy!==job)return;
        slot.busy=null;
        if(slot.worker===worker)slot.worker=null;
        job.reject(new Error('HEIC decode timed out'));
        worker.terminate().catch?.(()=>{});
        pump();
      },DECODE_TIMEOUT_MS);
      job.timer.unref?.();
    } catch (error) {
      rejectSlot(slot, error);
    }
  }
}

export function decodeHeic(path, options = {}) {
  return new Promise((resolve, reject) => {
    const job = {
      id: ++nextId,
      path: String(path || ''),
      edge: Number(options.edge) || 0,
      quality: Number(options.quality) || 82,
      effort: Number(options.effort) || 2,
      portable:options.portable !== false,
      resolve,
      reject
    };
    if (options.priority === true) queue.unshift(job);
    else queue.push(job);
    pump();
  });
}
