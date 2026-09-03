const frame = document.querySelector('#filesFrame');
const filesPane = document.querySelector('#filesPane');
const storagePane = document.querySelector('#storagePane');
const folders = document.querySelector('#folders');
const menu = document.querySelector('.client-menu');
const manageButton = document.querySelector('[data-client-tab="storage"]');
const pageKeys = new Set(['PageUp', 'PageDown']);

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
  #storagePane [data-preview-progress]{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#8e8683!important;font-weight:560!important}
  #storagePane [data-preview-progress]:before{content:'·';margin-right:7px;color:#5f595a}
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

function previewLabel(folder) {
  const phase = String(folder.previewPhase || '');
  const total = Number(folder.previewTotal) || 0;
  const processed = Math.min(total || Infinity, Number(folder.previewProcessed) || 0);
  const ready = Math.min(total || Infinity, Number(folder.previewReady) || 0);
  const failed = Number(folder.previewFailed) || 0;
  if (phase === 'counting') return 'Finding media previews…';
  if (folder.previewWarming && total) {
    if (phase === 'finishing') return `Previews ${processed.toLocaleString()} / ${total.toLocaleString()} · finishing…`;
    if (phase === 'checking') return `Previews ${ready.toLocaleString()} / ${total.toLocaleString()} · checking…`;
    return `Previews ${processed.toLocaleString()} / ${total.toLocaleString()}`;
  }
  if (!total) return '';
  return `${ready.toLocaleString()} previews${failed ? ` · ${failed.toLocaleString()} unavailable` : ''}`;
}

function renderPreviewProgress(stats) {
  const byPath = new Map((stats || []).map(folder => [pathKey(folder.path), folder]));
  let warming = false;
  for (const row of folders?.querySelectorAll(':scope > [data-folder-path]') || []) {
    const folder = byPath.get(pathKey(row.dataset.folderPath));
    const meta = row.querySelector('.storage-meta');
    if (!folder || !meta || folder.previewPhase == null) {
      row.querySelector('[data-preview-progress]')?.remove();
      continue;
    }
    warming ||= Boolean(folder.previewWarming);
    const text = previewLabel(folder);
    let node = row.querySelector('[data-preview-progress]');
    if (!text) {
      node?.remove();
      continue;
    }
    if (!node) {
      node = document.createElement('span');
      node.dataset.previewProgress = '';
      meta.append(node);
    }
    node.textContent = text;
    node.title = folder.previewWarming ? 'Generating local previews in the background' : 'Local preview cache';
  }
  return warming;
}

function schedulePreviewProgress(delay = 0) {
  if (progressTimer) return;
  progressTimer = setTimeout(refreshPreviewProgress, delay);
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

// The outer desktop header can own focus while the scrollable library lives in
// the iframe. Forward page keys so clicking the header never disables paging.
addEventListener('keydown', event => {
  if (!pageKeys.has(event.key) || filesPane?.hidden || document.querySelector('dialog[open]')) return;
  if (event.target?.closest?.('input,select,textarea,[contenteditable="true"]')) return;
  if (!frame?.contentWindow?.mochimonoPageKeys?.press?.(event.key)) return;
  frame.contentWindow.focus();
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);
