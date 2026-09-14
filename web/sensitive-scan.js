const WORKER_URL = new URL('./ai-sensitive-worker.js?v=falconsai-nsfw-v2', import.meta.url);
const THRESHOLD_KEY = 'mochimono-sensitive-threshold';
const DEFAULT_THRESHOLD = .65;

let threshold = clampThreshold(localStorage.getItem(THRESHOLD_KEY));
let worker = null;
let sequence = 0;
let busy = false;
const pending = new Map();

function clampThreshold(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_THRESHOLD;
  return Math.max(.5, Math.min(.95, number));
}

function requestJson(url, options = {}) {
  return fetch(url, {
    cache:'no-store',
    ...options,
    headers:{ 'content-type':'application/json', ...(options.headers || {}) },
    body:options.body == null || typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
  }).then(async response => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  });
}

function progressNode() {
  return document.querySelector('.tag-manager .tag-editor .tag-ai-status');
}

function setProgress(text) {
  const node = progressNode();
  if (!node) return;
  node.textContent = text || '';
  node.classList.toggle('busy', Boolean(text));
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
    pending.delete(String(data.id));
    if (data.type === 'error') {
      const error = new Error(data.error || 'Sensitive scan failed');
      if (data.aborted) error.name = 'AbortError';
      job.reject(error);
    } else job.resolve(data.result);
  };
  worker.onerror = event => {
    const error = new Error(event.message || 'Sensitive scan worker failed');
    for (const job of pending.values()) job.reject(error);
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

function workerRequest(action, payload, options = {}) {
  const target = ensureWorker();
  const id = `${action}-${Date.now().toString(36)}-${(++sequence).toString(36)}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress:options.onProgress });
    try { target.postMessage({ id, action, payload }); }
    catch (error) { pending.delete(id); reject(error); }
  });
}

function classify(media, options = {}) {
  return workerRequest('sensitive', { media, threshold }, options);
}

function sensitiveTag() {
  return window.mochimonoTags?.tags?.().find(tag => String(tag.name || '').toLowerCase() === 'sensitive') || null;
}

async function sensitiveFileState(hash) {
  try {
    const data = await requestJson(`/api/tags/file/${encodeURIComponent(hash)}`);
    return (data.tags || []).find(row => String(row?.name || '').toLowerCase() === 'sensitive') || null;
  } catch {
    return null;
  }
}

async function inspectSensitive(hash, options = {}) {
  hash = String(hash || '');
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid file hash');
  const input = options.input === 'original' ? 'original' : 'thumbnail';
  const result = await workerRequest('inspect-sensitive', {
    hash,
    threshold,
    input,
    fresh:Boolean(options.fresh)
  }, options);
  const tag = await sensitiveFileState(hash);
  const excluded = Boolean(tag?.suppressed || Number(tag?.examplePolarity) === -1);
  const passesThreshold = Number(result?.score) >= threshold;
  let decision;
  if (input === 'original') decision = passesThreshold ? 'Original passes threshold' : 'Original is below threshold';
  else if (excluded) decision = 'Excluded by you';
  else decision = passesThreshold ? 'Scan would mark Sensitive' : 'Below scan threshold';
  return {
    ...result,
    threshold,
    passesThreshold,
    decision,
    tag:{
      source:tag?.source || null,
      confidence:tag?.confidence == null ? null : Number(tag.confidence),
      excluded,
      manual:tag?.source === 'manual',
      detected:tag?.source === 'system'
    }
  };
}

async function refreshSensitiveUi(tagId, message = '') {
  try { await window.mochimonoTags?.refresh?.(); } catch {}
  const mode = document.querySelector('#sensitiveMediaMode')?.value || 'hide';
  window.mochimonoTags?.sensitiveMode?.(mode);
  const manager = document.querySelector('.tag-manager');
  if (manager?.open) {
    const before = progressNode();
    const tagButton = manager.querySelector(`[data-manage-tag="${CSS.escape(String(tagId))}"]`);
    tagButton?.click();
    if (tagButton) {
      for (let attempt = 0; attempt < 24; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 25));
        const current = progressNode();
        if (current && current !== before) break;
      }
    }
  }
  if (message) setProgress(message);
}

async function runSensitiveScan({ openManager = false } = {}) {
  if (busy) {
    setProgress('Sensitive scan is already running…');
    return null;
  }
  busy = true;
  let tag = null;
  window.dispatchEvent(new CustomEvent('mochimono:ai-work-start', { detail:{ action:'sensitive', source:'sensitive-scan' } }));
  try {
    await window.mochimonoTags?.refresh?.();
    tag = sensitiveTag();
    if (!tag) throw new Error('Sensitive tag is unavailable');
    if (openManager && !document.querySelector('.tag-manager')?.open) await window.mochimonoTags.open(String(tag.id));

    setProgress('Preparing dedicated sensitive-content model…');
    const module = await import('./ai-engine.js');
    const ai = module.default || window.mochimonoAI;
    ai.releaseEmbeddingModels?.();
    const media = await ai.catalogMedia();
    if (!media.length) throw new Error('No media to scan');

    const state = await requestJson(`/api/tags/${encodeURIComponent(tag.id)}`);
    const negatives = new Set((state.examples || [])
      .filter(item => Number(item.polarity) === -1)
      .map(item => String(item.hash)));

    const result = await classify(media, {
      onProgress:event => {
        if (event.detail) setProgress(event.detail);
      }
    });
    const matches = (result?.matches || [])
      .filter(item => !negatives.has(String(item.hash)))
      .map(item => ({ hash:String(item.hash), confidence:Number(item.confidence) || threshold }));
    const stats = result?.stats || {};
    const runtime = result?.runtime || {};

    setProgress(`Applying ${matches.length.toLocaleString()} sensitive matches…`);
    const applied = await requestJson(`/api/tags/${encodeURIComponent(tag.id)}/ai-members`, {
      method:'POST',
      body:{ matches, source:'system' }
    });

    const cached = Number(stats.cached) || 0;
    const classified = Number(stats.classified) || 0;
    const failed = Number(stats.failed) || 0;
    const backend = runtime.backend === 'webgpu' ? 'GPU' : runtime.backend === 'wasm' ? 'CPU' : 'cache';
    const parts = [
      `${Number(applied.count || 0).toLocaleString()} sensitive items marked`,
      `${Math.round(threshold * 100)}% threshold`,
      classified ? `${classified.toLocaleString()} scanned` : '',
      cached ? `${cached.toLocaleString()} cached` : '',
      failed ? `${failed.toLocaleString()} skipped` : '',
      backend
    ].filter(Boolean);
    const message = parts.join(' · ');
    await refreshSensitiveUi(tag.id, message);
    setTimeout(() => {
      if (progressNode()?.textContent === message) setProgress('');
    }, 4500);
    return result;
  } catch (error) {
    console.error(error);
    setProgress(error?.message || String(error));
    throw error;
  } finally {
    busy = false;
    window.dispatchEvent(new CustomEvent('mochimono:ai-work-end', { detail:{ action:'sensitive', source:'sensitive-scan' } }));
  }
}

document.addEventListener('click', event => {
  const button = event.target.closest?.('[data-scan-sensitive],[data-tag-sensitive-scan]');
  if (!button) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  runSensitiveScan({ openManager:button.hasAttribute('data-scan-sensitive') }).catch(() => {});
}, true);

if (window.mochimonoTags) window.mochimonoTags.scanSensitive = () => runSensitiveScan();

window.mochimonoSensitiveScan = {
  run:runSensitiveScan,
  inspect:inspectSensitive,
  busy:() => busy,
  threshold:() => threshold,
  setThreshold(value) {
    threshold = clampThreshold(value);
    localStorage.setItem(THRESHOLD_KEY, String(threshold));
    window.dispatchEvent(new CustomEvent('mochimono:sensitive-threshold', { detail:{ threshold } }));
    return threshold;
  }
};