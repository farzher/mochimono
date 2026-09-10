const WORKER_URL = new URL('./ai-worker.js', import.meta.url);
const IMAGE_EXTENSIONS = new Set(['jpg','jpeg','png','gif','webp','heic','heif','avif','bmp','tif','tiff']);
const VIDEO_EXTENSIONS = new Set(['mp4','m4v','mov','mkv','webm','avi','mpg','mpeg','m2v','mts','m2ts','3gp']);
const HEAVY_ACTIONS = new Set(['index','similar','search','groups','describe','mask']);
let worker = null;
let sequence = 0;
let heavyJobs = 0;
const pending = new Map();

function extension(name) {
  return String(name || '').toLowerCase().match(/\.([^.]+)$/)?.[1] || '';
}

function kindFor(file) {
  const mime = String(file?.mime || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  const ext = extension(file?.filename || file?.originalPath);
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  return '';
}

function mediaRecord(file) {
  const hash = String(file?.hash || '');
  const type = file?.type === 'image' || file?.type === 'video' ? file.type : kindFor(file);
  if (!/^[a-f0-9]{64}$/.test(hash) || !type) return null;
  return {
    hash,
    filename:String(file?.filename || file?.name || hash),
    type,
    width:Number(file?.width) || 0,
    height:Number(file?.height) || 0,
    dateMs:Number(file?.dateMs) || Date.parse(file?.fileDate || file?.createdAt || 0) || 0,
    size:Number(file?.size) || 0
  };
}

function beginHeavy(action, id) {
  heavyJobs++;
  if (heavyJobs !== 1) return;
  window.dispatchEvent(new CustomEvent('mochimono:ai-work-start', { detail:{ action, id, source:'ai-engine' } }));
}

function endHeavy(action, id) {
  heavyJobs = Math.max(0, heavyJobs - 1);
  if (heavyJobs) return;
  window.dispatchEvent(new CustomEvent('mochimono:ai-work-end', { detail:{ action, id, source:'ai-engine' } }));
}

function settleJob(id) {
  const job = pending.get(String(id || ''));
  if (!job) return null;
  pending.delete(String(id));
  job.signal?.removeEventListener('abort', job.abort);
  if (job.heavy) endHeavy(job.action, id);
  return job;
}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(WORKER_URL, { type:'module' });
  worker.onmessage = event => {
    const data = event.data || {};
    const job = pending.get(String(data.id || ''));
    if (!job) return;
    if (data.type === 'progress') {
      job.onProgress?.(data);
      return;
    }
    settleJob(data.id);
    if (data.type === 'error') {
      const error = new Error(data.error || 'AI operation failed');
      if (data.aborted) error.name = 'AbortError';
      job.reject(error);
    } else {
      job.resolve(data.result);
    }
  };
  worker.onerror = event => {
    const error = new Error(event.message || 'AI worker failed');
    for (const id of [...pending.keys()]) {
      const job = settleJob(id);
      job?.reject(error);
    }
    worker?.terminate();
    worker = null;
  };
  return worker;
}

function request(action, payload = {}, options = {}) {
  const id = `ai-${Date.now().toString(36)}-${(++sequence).toString(36)}`;
  const target = ensureWorker();
  return new Promise((resolve, reject) => {
    const signal = options.signal || null;
    const heavy = HEAVY_ACTIONS.has(action);
    const abort = () => {
      target.postMessage({ id:`cancel-${id}`, action:'cancel', cancelId:id });
      const job = settleJob(id);
      if (!job) return;
      reject(signal?.reason || new DOMException('Aborted', 'AbortError'));
    };
    if (signal?.aborted) return reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    signal?.addEventListener('abort', abort, { once:true });
    pending.set(id, { resolve, reject, onProgress:options.onProgress, signal, abort, heavy, action });
    if (heavy) beginHeavy(action, id);
    target.postMessage({ id, action, payload });
  });
}

async function catalogMedia() {
  const byHash = new Map();
  try {
    const snapshot = await window.mochimonoCatalogCache?.load?.();
    for (const file of snapshot?.files || []) {
      const media = mediaRecord(file);
      if (media) byHash.set(media.hash, media);
    }
  } catch {}

  for (const item of window.mochimonoGridModel?.items || []) {
    const media = mediaRecord({
      hash:item?.[0],
      filename:item?.[1],
      type:item?.[2],
      width:item?.[3],
      height:item?.[4],
      dateMs:item?.[5],
      size:item?.[6]
    });
    if (media) byHash.set(media.hash, { ...(byHash.get(media.hash) || {}), ...media });
  }

  return [...byHash.values()];
}

async function currentViewMedia() {
  const items = window.mochimonoGridModel?.items || [];
  const result = [];
  const seen = new Set();
  for (const item of items) {
    const media = mediaRecord({
      hash:item?.[0],
      filename:item?.[1],
      type:item?.[2],
      width:item?.[3],
      height:item?.[4],
      dateMs:item?.[5],
      size:item?.[6]
    });
    if (!media || seen.has(media.hash)) continue;
    seen.add(media.hash);
    result.push(media);
  }
  if (result.length) return result;
  return catalogMedia();
}

async function withMedia(action, payload = {}, options = {}) {
  const media = options.scope === 'view' ? await currentViewMedia() : await catalogMedia();
  return request(action, { ...payload, media }, options);
}

const api = {
  status:(options = {}) => request('status', {}, options),
  clear:(options = {}) => request('clear', {}, options),
  catalogMedia,
  currentViewMedia,
  index:(model = 'siglip2', options = {}) => withMedia('index', { model }, options),
  similar:(targetHash, model = 'siglip2', options = {}) =>
    withMedia('similar', { targetHash:String(targetHash || ''), model, limit:options.limit || 40 }, options),
  search:(query, options = {}) =>
    withMedia('search', { query:String(query || ''), limit:options.limit || 80 }, options),
  groups:(options = {}) =>
    withMedia('groups', { limitPerGroup:options.limitPerGroup || 120 }, options),
  describe:(hash, prompt = '', options = {}) =>
    request('describe', { hash:String(hash || ''), prompt:String(prompt || '') }, options),
  masks:(hash, options = {}) =>
    request('mask', { hash:String(hash || '') }, options),
  busy:() => heavyJobs > 0,
  stop:() => {
    worker?.terminate();
    worker = null;
    for (const id of [...pending.keys()]) {
      const job = settleJob(id);
      job?.reject(new DOMException('AI worker stopped', 'AbortError'));
    }
  }
};

window.mochimonoAI = api;
window.dispatchEvent(new CustomEvent('mochimono:ai-ready', { detail:{ api } }));

export default api;
