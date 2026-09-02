const folders = document.querySelector('#folders');
const startBrowse = document.querySelector('#startBrowse');
const startProtect = document.querySelector('#startImport');
const importPath = document.querySelector('#importPath');
const folderAdd = document.querySelector('#folderAdd');
const showFolderAdd = document.querySelector('#showFolderAdd');
const frame = document.querySelector('#filesFrame');
let loading = false;
let queued = false;
let previewLoading = false;
let previewLoadedAt = 0;
let previewRetryTimer = 0;
let previewRetryAttempt = 0;
const previewSamples = new Map();
const readyPreviews = new Set();

const style = document.createElement('style');
style.textContent = `
  .storage-modes{display:inline-flex;gap:5px;margin-left:8px;vertical-align:1px}
  .storage-mode{display:inline-flex;padding:2px 6px;border-radius:999px;background:#211e22;color:#8f8784;font-size:9px;font-weight:700}
  .storage-mode.protected{color:#b8d1be}.storage-mode.local{color:#9da3af}
  .storage-open-folder svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.4;stroke-linejoin:round}
  #storagePane .folder-item.browse-only-folder .storage-meter{display:none}

  #storagePane .folder-item.has-folder-preview{grid-template-columns:236px minmax(0,1fr) 190px;min-height:156px;align-items:center}
  .storage-folder-samples{width:236px;height:132px;display:grid;grid-template-columns:1.55fr 1fr 1fr;grid-template-rows:1fr 1fr;gap:3px;border-radius:12px;overflow:hidden;background:#0b0a0c;cursor:pointer}
  .storage-folder-sample{position:relative;display:grid;place-items:center;min-width:0;min-height:0;overflow:hidden;background:#19171a;color:#706967}
  .storage-folder-sample:first-child{grid-row:1 / 3}
  .storage-folder-sample img{width:100%;height:100%;display:block;object-fit:cover;background:#0b0a0c}
  .storage-folder-sample.video::after{content:'▶';position:absolute;left:7px;bottom:6px;width:22px;height:22px;display:grid;place-items:center;border-radius:50%;background:rgba(0,0,0,.62);color:#fff;font-size:8px;padding-left:1px}
  .storage-folder-sample b{font-size:18px;font-weight:700;color:#645d5d}
  .storage-folder-sample small{position:absolute;left:5px;right:5px;bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#77706e;font-size:7px;text-align:center}
  .storage-folder-samples:hover{outline:1px solid #4a4348;outline-offset:1px}

  @media(max-width:700px){
    #storagePane .folder-item.has-folder-preview{grid-template-columns:128px minmax(0,1fr);gap:10px;align-items:start}
    #storagePane .folder-item.has-folder-preview .storage-folder-samples{width:128px;height:104px;grid-row:1 / span 2}
    #storagePane .folder-item.has-folder-preview .item-actions{grid-column:2}
  }
`;
document.head.append(style);

const samePath = (a, b) => String(a || '').replace(/[\\/]+$/, '').toLowerCase() === String(b || '').replace(/[\\/]+$/, '').toLowerCase();
const previewKey = value => String(value || '').replace(/[\\/]+$/, '').toLowerCase();
const setText = (node, value) => { if (node && node.textContent !== value) node.textContent = value; };

function toast(text) {
  const node = document.querySelector('#toast');
  if (!node) return;
  node.textContent = text;
  node.classList.add('show');
  clearTimeout(node.timer);
  node.timer = setTimeout(() => node.classList.remove('show'), 2800);
}

async function request(path, options = {}) {
  const response = await fetch(path, { headers: { 'content-type':'application/json' }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

function refreshLibrary() {
  frame?.contentWindow?.mochimonoLibrary?.refresh?.().catch?.(() => {});
  frame?.contentWindow?.mochimonoLocations?.refresh?.().catch?.(() => {});
}

function sampleGlyph(file) {
  const mime = String(file?.mime || '');
  if (mime.startsWith('video/')) return '▶';
  if (mime.startsWith('audio/')) return '♪';
  if (mime.startsWith('image/')) return '▧';
  return '▤';
}

function renderFolderPreview(row) {
  const sample = previewSamples.get(previewKey(row.dataset.folderPath));
  const files = sample?.files || [];
  let strip = row.querySelector('.storage-folder-samples');
  if (!files.length) {
    strip?.remove();
    row.classList.remove('has-folder-preview');
    return;
  }
  if (!strip) {
    strip = document.createElement('div');
    strip.className = 'storage-folder-samples';
    row.prepend(strip);
  }
  strip.dataset.openNativeFolderPath = row.dataset.folderPath || '';
  strip.title = 'Show in folder';
  row.classList.add('has-folder-preview');

  const key = JSON.stringify(files.slice(0, 5).map(file => [
    file.hash, file.filename, file.mime, readyPreviews.has(String(file.hash))
  ]));
  if (strip.dataset.key === key) return;
  strip.dataset.key = key;

  const cells = [];
  for (let index = 0; index < 5; index++) {
    const file = files[index];
    if (!file) {
      cells.push('<span class="storage-folder-sample"></span>');
      continue;
    }
    const hash = String(file.hash || '');
    const mime = String(file.mime || '');
    const media = mime.startsWith('image/') || mime.startsWith('video/');
    const ready = media && readyPreviews.has(hash);
    if (ready) {
      cells.push(`<span class="storage-folder-sample ${mime.startsWith('video/') ? 'video' : ''}" title="${String(file.filename || '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]))}"><img src="/api/thumbs/${hash}" alt="" loading="lazy" decoding="async"></span>`);
    } else {
      const filename = String(file.filename || '');
      const safe = filename.replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
      cells.push(`<span class="storage-folder-sample ${mime.startsWith('video/') ? 'video' : ''}" title="${safe}"><b>${sampleGlyph(file)}</b><small>${safe}</small></span>`);
    }
  }
  strip.innerHTML = cells.join('');
}

function renderFolderPreviews() {
  for (const row of folders?.querySelectorAll('[data-folder-path]') || []) renderFolderPreview(row);
}

function sampleMediaHashes() {
  const hashes = [];
  const seen = new Set();
  for (const sample of previewSamples.values()) {
    for (const file of sample.files || []) {
      const mime = String(file?.mime || '');
      const hash = String(file?.hash || '');
      if (!hash || !/^(image|video)\//.test(mime) || seen.has(hash)) continue;
      seen.add(hash);
      hashes.push(hash);
    }
  }
  return hashes;
}

async function checkSamplePreviews(hashes) {
  const ready = new Set();
  for (let offset = 0; offset < hashes.length; offset += 400) {
    const chunk = hashes.slice(offset, offset + 400);
    const data = await request('/api/thumbs/check', {
      method:'POST',
      body:JSON.stringify({ background:true, hashes:chunk })
    });
    for (const item of data.thumbnails || []) ready.add(String(item.hash));
  }
  return ready;
}

function schedulePreviewRetry() {
  clearTimeout(previewRetryTimer);
  const hashes = sampleMediaHashes().filter(hash => !readyPreviews.has(hash));
  if (!hashes.length || previewRetryAttempt >= 3) return;
  const delays = [700, 1600, 3200];
  const delay = delays[previewRetryAttempt++] || 3200;
  previewRetryTimer = setTimeout(async () => {
    try {
      const ready = await checkSamplePreviews(hashes);
      for (const hash of ready) readyPreviews.add(hash);
      renderFolderPreviews();
      schedulePreviewRetry();
    } catch {}
  }, delay);
}

async function refreshFolderPreviews(force = false) {
  if (previewLoading) return;
  const rows = [...(folders?.querySelectorAll('[data-folder-path]') || [])];
  const missingFolder = rows.some(row => !previewSamples.has(previewKey(row.dataset.folderPath)));
  if (!force && !missingFolder && previewLoadedAt && Date.now() - previewLoadedAt < 30_000) {
    renderFolderPreviews();
    return;
  }

  previewLoading = true;
  try {
    const data = await request('/api/client/local-catalog?limit=5');
    previewSamples.clear();
    for (const sample of data.folderSamples || []) previewSamples.set(previewKey(sample.path), sample);
    previewLoadedAt = Date.now();
    previewRetryAttempt = 0;

    // The folder mosaic itself does not depend on thumbnail generation. Show it
    // immediately with file glyphs/names, then upgrade individual cells as their
    // cached thumbnails become available. A transient thumbnail-check failure
    // must never make the whole visual preview disappear.
    renderFolderPreviews();
    const hashes = sampleMediaHashes();
    try {
      const ready = await checkSamplePreviews(hashes);
      readyPreviews.clear();
      for (const hash of ready) readyPreviews.add(hash);
      renderFolderPreviews();
    } catch {}
    schedulePreviewRetry();
  } catch {}
  finally { previewLoading = false; }
}

function decorateRow(row, folder) {
  const protectedFolder = folder.protected !== false;
  row.classList.toggle('browse-only-folder', !protectedFolder);
  const title = row.querySelector('.storage-title strong');
  if (title) {
    setText(title, folder.path);
    title.title = 'Show in folder';
    title.dataset.openNativeFolderPath = folder.path;
  }

  let badges = row.querySelector('[data-folder-mode]');
  if (!badges) {
    badges = document.createElement('span');
    badges.dataset.folderMode = '';
    title?.after(badges);
  }
  badges.className = 'storage-modes';
  const locations = protectedFolder ? ['This PC', 'Mochimono'] : ['This PC'];
  const key = locations.join('|');
  if (badges.dataset.locations !== key) {
    badges.dataset.locations = key;
    badges.replaceChildren(...locations.map((label, index) => {
      const badge = document.createElement('span');
      badge.className = `storage-mode ${index ? 'protected' : 'local'}`;
      badge.textContent = label;
      badge.title = label === 'Mochimono'
        ? 'Mochimono keeps another copy.'
        : 'The original files are on this PC.';
      return badge;
    }));
  }

  const actions = row.querySelector('.item-actions');
  let open = actions?.querySelector('[data-open-native-folder]');
  if (actions && !open) {
    open = document.createElement('button');
    open.type = 'button';
    open.className = 'icon tiny storage-open-folder';
    open.dataset.openNativeFolder = '';
    open.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2.8 5.7h5l1.5-1.8h2.5l1.3 1.8h4.1v9.4H2.8z"/></svg>';
    actions.prepend(open);
  }
  if (open) {
    open.dataset.path = folder.path;
    open.title = 'Show in folder';
    open.setAttribute('aria-label', 'Show in folder');
  }

  const sync = row.querySelector('[data-sync-folder]');
  if (sync) setText(sync, protectedFolder ? 'Sync' : 'Index');
  const status = row.querySelector('[data-folder-status]');
  if (!protectedFolder && status) setText(status, 'Local');
  else if (protectedFolder && status && !folder.lastSynced) setText(status, 'Waiting to sync');

  const remove = row.querySelector('[data-remove-folder]');
  if (remove) {
    const label = protectedFolder ? 'Stop keeping Mochimono copy' : 'Stop browsing';
    remove.title = label;
    remove.setAttribute('aria-label', label);
  }

  const existingProtect = actions?.querySelector('[data-protect-folder]');
  if (!protectedFolder && actions && !existingProtect) {
    const button = document.createElement('button');
    button.className = 'action-link primary-action';
    button.dataset.protectFolder = folder.path;
    button.textContent = 'Add Mochimono copy';
    actions.prepend(button);
  } else if (protectedFolder) existingProtect?.remove();
}

async function annotate() {
  if (loading) { queued = true; return; }
  loading = true;
  queued = false;
  try {
    const state = await request('/api/state');
    const configured = state.settings?.folders || [];
    for (const row of folders?.querySelectorAll('[data-folder-path]') || []) {
      const folder = configured.find(item => samePath(item.path, row.dataset.folderPath));
      if (folder) decorateRow(row, folder);
    }
    refreshFolderPreviews().catch(() => {});
  } catch {}
  finally {
    loading = false;
    if (queued) queueMicrotask(annotate);
  }
}

const annotateSoon = () => {
  if (queued) return;
  queued = true;
  queueMicrotask(annotate);
};

startBrowse?.addEventListener('click', async () => {
  const path = importPath.value.trim();
  if (!path) return;
  startBrowse.disabled = true;
  try {
    await request('/api/browse-folders', { method:'POST', body:JSON.stringify({ path }) });
    importPath.value = '';
    folderAdd.hidden = true;
    showFolderAdd.classList.remove('active');
    previewLoadedAt = 0;
    annotateSoon();
    setTimeout(refreshLibrary, 350);
  } catch (error) { toast(error.message); }
  finally { startBrowse.disabled = false; }
});

folders?.addEventListener('click', async event => {
  const open = event.target.closest('[data-open-native-folder]');
  const title = event.target.closest('[data-open-native-folder-path]');
  if (open || title) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const path = open?.dataset.path || title?.dataset.openNativeFolderPath;
    try { await request('/api/open-folder', { method:'POST', body:JSON.stringify({ path }) }); }
    catch (error) { toast(error.message); }
    return;
  }

  const protect = event.target.closest('[data-protect-folder]');
  if (!protect) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  protect.disabled = true;
  try {
    await request('/api/browse-folders/protect', { method:'POST', body:JSON.stringify({ path:protect.dataset.protectFolder }) });
    previewLoadedAt = 0;
    annotateSoon();
    setTimeout(refreshLibrary, 350);
  } catch (error) { toast(error.message); }
  finally { protect.disabled = false; }
}, true);

window.addEventListener('mochimono-folder-intent-ui', event => {
  if (folderAdd.hidden) showFolderAdd?.click();
  if (event.detail?.mode === 'browse') startBrowse?.focus();
  else startProtect?.focus();
});

// Folder rows are replaced only when the configured folder structure changes.
// Watching their entire subtrees made our own progress/timestamp/preview DOM
// updates trigger another state fetch and decoration pass, creating needless
// repaint churn while a sync was running.
if (folders) new MutationObserver(annotateSoon).observe(folders, { childList:true });
annotateSoon();
