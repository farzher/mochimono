const frame = document.querySelector('#filesFrame');
const filesPane = document.querySelector('#filesPane');
const storagePane = document.querySelector('#storagePane');
const folders = document.querySelector('#folders');
const menu = document.querySelector('.client-menu');
const manageButton = document.querySelector('[data-client-tab="storage"]');
const pageKeys = new Set(['PageUp', 'PageDown', 'Home', 'End']);

const pathKey = value => String(value || '').trim().replace(/[\\/]+$/, '').toLowerCase();

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

// Storage is important enough to deserve one visible affordance, but not a full
// text tab in the header. Keep the existing menu entry as the implementation and
// make this compact icon toggle invoke it.
let storageShortcut = null;
if (menu && manageButton) {
  storageShortcut = document.createElement('button');
  storageShortcut.type = 'button';
  storageShortcut.className = 'storage-shortcut';
  storageShortcut.innerHTML = `
    <svg class="storage-shortcut-storage" viewBox="0 0 20 20" aria-hidden="true"><path d="M3.25 5.25h13.5v9.5H3.25z"/><path d="M5.25 12.25h1M8.5 12.25h6"/></svg>
    <svg class="storage-shortcut-library" viewBox="0 0 20 20" aria-hidden="true"><rect x="3.5" y="3.5" width="5" height="5" rx=".7"/><rect x="11.5" y="3.5" width="5" height="5" rx=".7"/><rect x="3.5" y="11.5" width="5" height="5" rx=".7"/><rect x="11.5" y="11.5" width="5" height="5" rx=".7"/></svg>`;
  menu.before(storageShortcut);
  storageShortcut.addEventListener('click', () => manageButton.click());
}

function syncStorageShortcut() {
  if (!storageShortcut) return;
  const storage = storagePane && !storagePane.hidden;
  storageShortcut.classList.toggle('active', Boolean(storage));
  storageShortcut.title = storage ? 'Library' : 'Storage';
  storageShortcut.setAttribute('aria-label', storageShortcut.title);
}
syncStorageShortcut();
if (storagePane) new MutationObserver(syncStorageShortcut).observe(storagePane, { attributes: true, attributeFilter: ['hidden'] });

const style = document.createElement('style');
style.textContent = `
  .storage-shortcut{width:31px;height:31px;display:grid;place-items:center;padding:0;border:0;border-radius:8px;background:transparent;color:#8d8584}
  .storage-shortcut:hover,.storage-shortcut.active{background:#211e22;color:#eee7e3}
  .storage-shortcut svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.45;stroke-linecap:round;stroke-linejoin:round}
  .storage-shortcut .storage-shortcut-library{display:none}
  .storage-shortcut.active .storage-shortcut-storage{display:none}
  .storage-shortcut.active .storage-shortcut-library{display:block}
`;
document.head.append(style);

// Folder-card samples are outside the library iframe. Merely requesting their
// thumbnail URL cannot create a missing local preview, so explicitly run them
// through the same thumbnail check/queue path used by the grid.
const pendingThumbs = new Set();
let thumbTimer = 0;
let checkingThumbs = false;

function thumbHash(img) {
  try {
    const match = new URL(img.src, location.href).pathname.match(/^\/api\/thumbs\/([a-f0-9]{64})$/);
    return match?.[1] || '';
  } catch { return ''; }
}

function collectSampleThumbs(root = folders) {
  if (!root) return;
  const images = root.matches?.('.storage-folder-sample img') ? [root] : [...root.querySelectorAll?.('.storage-folder-sample img') || []];
  for (const image of images) {
    const hash = thumbHash(image);
    if (!hash || image.dataset.previewQueued === hash) continue;
    image.dataset.previewQueued = hash;
    pendingThumbs.add(hash);
  }
  if (pendingThumbs.size && !thumbTimer) thumbTimer = setTimeout(flushSampleThumbs, 40);
}

async function flushSampleThumbs() {
  thumbTimer = 0;
  if (checkingThumbs || !pendingThumbs.size) return;
  checkingThumbs = true;
  try {
    while (pendingThumbs.size) {
      const hashes = [...pendingThumbs].slice(0, 500);
      hashes.forEach(hash => pendingThumbs.delete(hash));
      await request('/api/thumbs/check', { method: 'POST', body: { hashes } });
    }
  } catch {
    // The sample image's existing retry loop remains the visual fallback. A
    // later folder mutation/refresh will enqueue another check if needed.
  } finally {
    checkingThumbs = false;
    if (pendingThumbs.size && !thumbTimer) thumbTimer = setTimeout(flushSampleThumbs, 250);
  }
}

collectSampleThumbs();
if (folders) new MutationObserver(records => {
  for (const record of records) for (const node of record.addedNodes) if (node instanceof Element) collectSampleThumbs(node);
  schedulePreviewProgress(80);
}).observe(folders, { childList: true, subtree: true });

let progressTimer = 0;
let progressBusy = false;
const previewMemory = new Map();

const previewMode = () => window.mochimonoPreviewMode?.() || 'idle';

function previewInfo(folder) {
  const key = pathKey(folder.path);
  const previous = previewMemory.get(key) || null;
  const phase = String(folder.previewPhase || '');
  const failed = Number(folder.previewFailed) || previous?.failed || 0;
  let total = Number(folder.previewTotal) || 0;
  let processed = Number(folder.previewProcessed) || 0;

  // Off intentionally drops the active discovery pass on the agent. Keep the
  // last real folder progress visible while it is paused, and while a resumed
  // pass recounts/checks the same on-disk thumbnail cache.
  if (!total && previous?.total) total = previous.total;
  if (total && previous?.processed) processed = Math.max(processed, Math.min(total, previous.processed));

  if (!phase && !previous) return null;
  if (phase === 'counting' && !previous?.total) {
    return { key, phase, total: 0, processed: 0, failed: 0, text: 'Finding media…', percent: '', ratio: 0, indeterminate: true, working: true };
  }

  const done = phase === 'done' || previous?.done && !phase;
  if (done && total) processed = total;
  let ratio = total ? Math.max(0, Math.min(1, processed / total)) : 0;
  if (!done && ratio >= 1) ratio = .99;
  const percent = total ? `${done ? 100 : Math.floor(ratio * 100)}%` : '';
  const mode = previewMode();
  const count = total ? `${Math.min(processed, total).toLocaleString()} / ${total.toLocaleString()}` : '';
  let suffix = '';
  if (done) suffix = failed ? `${failed.toLocaleString()} unavailable` : 'Ready';
  else if (mode === 'off') suffix = 'On demand';
  else if (phase === 'counting') suffix = 'Resuming…';
  else if (phase === 'finishing' || phase === 'checking') suffix = 'Finishing…';
  else suffix = mode === 'max' ? 'Max' : 'Background';
  const text = [count, suffix].filter(Boolean).join(' · ');
  const info = { key, phase, total, processed, failed, text, percent, ratio, indeterminate: false, done, working: Boolean(folder.previewWarming) };

  if (total || previous) previewMemory.set(key, {
    total: total || previous?.total || 0,
    processed: Math.max(processed, previous?.processed || 0),
    failed,
    done: Boolean(done || previous?.done)
  });
  return info;
}

function previewNode(row) {
  let node = row.querySelector('[data-preview-progress]');
  if (node) return node;
  node = document.createElement('div');
  node.dataset.previewProgress = '';
  node.innerHTML = `<div class="preview-progress-head"><span class="preview-progress-title">Previews</span><span data-preview-progress-text></span><strong data-preview-percent></strong></div><div class="preview-progress-track"><i></i></div>`;
  const copy = row.querySelector('.storage-copy');
  const meter = row.querySelector('.storage-meter');
  if (meter) meter.insertAdjacentElement('afterend', node);
  else copy?.append(node);
  return node;
}

function renderPreviewProgress(stats) {
  const byPath = new Map((stats || []).map(folder => [pathKey(folder.path), folder]));
  let warming = false;
  for (const row of folders?.querySelectorAll(':scope > [data-folder-path]') || []) {
    const folder = byPath.get(pathKey(row.dataset.folderPath));
    if (!folder) {
      row.querySelector('[data-preview-progress]')?.remove();
      continue;
    }
    const info = previewInfo(folder);
    if (!info) {
      row.querySelector('[data-preview-progress]')?.remove();
      continue;
    }
    warming ||= Boolean(info.working);
    const node = previewNode(row);
    node.classList.toggle('preview-indeterminate', info.indeterminate);
    node.querySelector('[data-preview-progress-text]').textContent = info.text;
    node.querySelector('[data-preview-percent]').textContent = info.percent;
    node.style.setProperty('--preview-progress', String(info.ratio));
    node.title = info.done ? 'Local previews ready' : previewMode() === 'off' ? 'Background preview generation is off; visible files still generate on demand' : 'Generating local previews in the background';
  }
  return warming;
}

function schedulePreviewProgress(delay = 0) {
  if (progressTimer) {
    if (delay > 0) return;
    clearTimeout(progressTimer);
  }
  progressTimer = setTimeout(refreshPreviewProgress, Math.max(0, delay));
}

async function refreshPreviewProgress() {
  progressTimer = 0;
  if (progressBusy) return schedulePreviewProgress(500);
  progressBusy = true;
  let warming = false;
  try {
    warming = renderPreviewProgress((await request('/api/folder-stats')).folders || []);
  } catch {}
  finally {
    progressBusy = false;
    schedulePreviewProgress(warming ? 1200 : 7000);
  }
}
schedulePreviewProgress(120);
window.addEventListener('mochimono:preview-mode', () => schedulePreviewProgress(0));

// The outer desktop header can own focus while the scrollable library lives in
// the iframe. Forward page/edge keys so clicking the header never disables them.
addEventListener('keydown', event => {
  if (!pageKeys.has(event.key) || filesPane?.hidden || document.querySelector('dialog[open]')) return;
  if (event.target?.closest?.('input,select,textarea,[contenteditable="true"]')) return;
  if (!frame?.contentWindow?.mochimonoPageKeys?.press?.(event.key)) return;
  frame.contentWindow.focus();
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);
