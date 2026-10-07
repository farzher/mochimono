const folders = document.querySelector('#folders');
const frame = document.querySelector('#filesFrame');
const storagePane = document.querySelector('#storagePane');

let annotating = false;
let annotateQueued = false;
let previewLoading = false;
let previewLoadedAt = 0;
let previewTimer = 0;
const previewSamples = new Map();
const readyPreviewHashes = new Set();
const failedPreviewHashes = new Set();

const style = document.createElement('style');
style.textContent = `
  .storage-folder-samples{
    width:260px;height:140px;display:grid;
    grid-template-columns:1.55fr 1fr 1fr;grid-template-rows:1fr 1fr;
    gap:3px;overflow:hidden;border-radius:13px;background:#0a090b;cursor:pointer;
    color:inherit;text-decoration:none
  }
  .storage-folder-sample{
    position:relative;display:grid;place-items:center;min-width:0;min-height:0;
    overflow:hidden;background:#181619;color:#5f5858
  }
  .storage-folder-sample:first-child{grid-row:1 / 3}
  .storage-folder-sample img{
    position:absolute;inset:0;width:100%;height:100%;display:block;object-fit:cover;
    background:#0a090b;opacity:0;transition:opacity .14s ease
  }
  .storage-folder-sample.thumb-ready img{opacity:1}
  .storage-folder-sample .sample-glyph{font-size:19px;font-weight:650;color:#625b5d}
  .storage-folder-sample .sample-name{
    position:absolute;left:5px;right:5px;bottom:4px;overflow:hidden;text-overflow:ellipsis;
    white-space:nowrap;color:#746d6b;font-size:7px;text-align:center
  }
  .storage-folder-sample.thumb-ready .sample-glyph,
  .storage-folder-sample.thumb-ready .sample-name{display:none}
  .storage-folder-sample.video.thumb-ready:after{
    content:'▶';position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
    width:34px;height:34px;display:grid;place-items:center;border-radius:50%;
    background:rgba(0,0,0,.62);box-shadow:0 2px 10px rgba(0,0,0,.28);
    color:#fff;font-size:12px;padding-left:2px
  }
  .storage-folder-samples{position:relative;background:#19161b}
  .storage-folder-sample.pending{background:linear-gradient(120deg,#211d23 20%,#30252b 48%,#211d23 76%);background-size:250% 100%;animation:source-preview-shimmer 2.8s ease-in-out infinite}
  .storage-folder-sample.pending .sample-glyph{opacity:.26;font-size:24px}
  .storage-folder-sample .sample-name{display:none}
  .storage-folder-samples:after{content:'View files →';position:absolute;right:10px;bottom:9px;padding:5px 8px;border:1px solid #ffffff14;border-radius:7px;background:#191418cf;color:#e2ceca;font-size:10px;font-weight:650;opacity:0;transition:opacity .15s}
  .storage-folder-samples:hover:after,.storage-folder-samples:focus-visible:after{opacity:1}
  .storage-folder-samples:not(.has-previews):after{content:'Preparing previews';opacity:1;right:auto;left:10px;background:#19141880;color:#a58e92}
  .storage-folder-samples:hover{outline:1px solid rgba(255,255,255,.18);outline-offset:1px}
  @keyframes source-preview-shimmer{0%,100%{background-position:100% 0}50%{background-position:0 0}}
  @media(prefers-reduced-motion:reduce){.storage-folder-sample.pending{animation:none}}
  @media(max-width:700px){
    .storage-folder-samples{width:126px;height:104px;border-radius:10px}
  }
`;
document.head.append(style);

const pathKey = value => String(value || '').trim().replace(/[\\/]+$/, '').toLowerCase();
const samePath = (a, b) => pathKey(a) === pathKey(b);

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

function pathParts(path) {
  const clean = String(path || '').replace(/[\\/]+$/, '');
  const index = Math.max(clean.lastIndexOf('\\'), clean.lastIndexOf('/'));
  if (index < 0) return { parent:'', name:clean || path };
  return { parent:clean.slice(0, index + 1), name:clean.slice(index + 1) || clean };
}

function renderPath(row, path) {
  const title = row.querySelector('.storage-title strong');
  if (!title) return;
  const { parent, name } = pathParts(path);
  const key = `${parent}|${name}`;
  if (title.dataset.pathDisplay !== key) {
    title.dataset.pathDisplay = key;
    title.replaceChildren();
    if (parent) {
      const prefix = document.createElement('span');
      prefix.className = 'storage-path-parent';
      prefix.textContent = parent;
      title.append(prefix);
    }
    const final = document.createElement('b');
    final.className = 'storage-path-name';
    final.textContent = name;
    title.append(final);
  }
  title.title = `${path}\nShow in folder`;
  title.dataset.openNativeFolderPath = path;
}

function renderLocationBadge(row, cloud, scope) {
  let badges = row.querySelector('[data-folder-mode]');
  if (!badges) {
    badges = document.createElement('span');
    badges.dataset.folderMode = '';
    row.querySelector('.storage-title strong')?.after(badges);
  }
  const scopeLabel = scope === 'all' ? 'Everything' : 'Media';
  const text = cloud ? `Cloud · ${scopeLabel}` : scopeLabel;
  badges.className = 'storage-modes';
  if (badges.textContent !== text) badges.textContent = text;
  badges.title = cloud
    ? `${scopeLabel === 'Everything' ? 'All files' : 'Photos and videos'} · Cloud copy`
    : scopeLabel === 'Everything' ? 'All files' : 'Photos and videos';
}

function decorateRow(row, folder) {
  const cloud = folder.protected !== false;
  const scope = folder.scope === 'all' ? 'all' : 'media';
  row.classList.toggle('browse-only-folder', !cloud);
  row.classList.toggle('cloud-folder', cloud);
  row.dataset.folderImportId = String(folder.importId || '');
  renderPath(row, folder.path);
  renderLocationBadge(row, cloud, scope);

  const actions = row.querySelector('.item-actions');
  const sync = actions?.querySelector('[data-sync-folder]');
  if (sync) {
    sync.textContent = cloud ? 'Sync' : 'Index';
    sync.title = cloud ? 'Sync now' : 'Re-index';
  }
  actions?.querySelector('[data-open-native-folder]')?.remove();

  const existingCloud = actions?.querySelector('[data-protect-folder]');
  if (!cloud && actions && !existingCloud) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'action-link primary-action';
    button.dataset.protectFolder = folder.path;
    button.textContent = '+ Cloud';
    button.title = 'Keep a Cloud copy';
    actions.prepend(button);
  } else if (cloud) existingCloud?.remove();

  const remove = actions?.querySelector('[data-remove-folder]');
  if (remove) {
    const label = cloud ? 'Stop keeping this folder in Cloud' : 'Remove folder';
    remove.title = label;
    remove.setAttribute('aria-label', label);
  }
}

function mediaKind(file) {
  const mime = String(file?.mime || '');
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  return '';
}

function rankPreviewFiles(files) {
  const images = [];
  const videos = [];
  const seen = new Set();
  for (const file of Array.isArray(files) ? files : []) {
    const hash = String(file?.hash || '');
    const kind = mediaKind(file);
    if (!/^[a-f0-9]{64}$/.test(hash) || !kind || seen.has(hash)) continue;
    seen.add(hash);
    (kind === 'image' ? images : videos).push(file);
  }
  return [...images, ...videos];
}

function readyPreviewFiles(files) {
  return rankPreviewFiles(files).filter(file => readyPreviewHashes.has(String(file.hash || '')));
}

function previewCandidates(files) {
  const ranked = rankPreviewFiles(files).filter(file => !failedPreviewHashes.has(String(file.hash)));
  const ready = [];
  const unchecked = [];
  for (const file of ranked) {
    (readyPreviewHashes.has(String(file.hash || '')) ? ready : unchecked).push(file);
  }
  return [...ready, ...unchecked];
}

function sampleGlyph(file) { return mediaKind(file) === 'video' ? '▷' : '◇'; }
function thumbUrl(hash) { return `/api/thumbs/${encodeURIComponent(hash)}`; }

function installThumb(img, cell, hash, onReject) {
  img.addEventListener('load', () => {
    readyPreviewHashes.add(hash);
    cell.classList.remove('pending');
    cell.classList.add('thumb-ready');
    cell.closest('.storage-folder-samples')?.classList.add('has-previews');
  });
  img.addEventListener('error', () => {
    cell.classList.remove('thumb-ready');
    readyPreviewHashes.delete(hash);
    onReject?.(cell);
  });
}

function sampleCell(file, index, onReject) {
  const cell = document.createElement('span');
  cell.className = 'storage-folder-sample pending';
  if (!file) {
    if (index === 0) {
      const glyph = document.createElement('span');
      glyph.className = 'sample-glyph'; glyph.textContent = '▱'; cell.append(glyph);
    }
    return cell;
  }
  const filename = String(file.filename || '');
  const kind = mediaKind(file);
  const hash = String(file.hash || '');
  cell.title = filename;
  if (kind === 'video') cell.classList.add('video');
  const glyph = document.createElement('span'); glyph.className = 'sample-glyph'; glyph.textContent = sampleGlyph(file);
  const name = document.createElement('small'); name.className = 'sample-name'; name.textContent = filename;
  cell.append(glyph, name);
  if (kind && readyPreviewHashes.has(hash)) {
    const img = document.createElement('img');
    img.alt = ''; img.loading = 'eager'; img.decoding = 'async';
    installThumb(img, cell, hash, onReject);
    img.src = thumbUrl(hash);
    cell.append(img);
  }
  return cell;
}

function renderFolderPreview(row) {
  const sample = previewSamples.get(pathKey(row.dataset.folderPath));
  const candidates = previewCandidates(sample?.files);
  let strip = row.querySelector('.storage-folder-samples');
  if (!strip) {
    strip = document.createElement('a');
    strip.className = 'storage-folder-samples storage-source-link';
    strip.href = '#';
    row.prepend(strip);
  }
  row.classList.add('has-folder-preview');
  strip.removeAttribute('data-open-library-folder');
  strip.title = 'View in Library';

  strip.classList.toggle('has-previews', candidates.some(file => readyPreviewHashes.has(String(file.hash))));
  const key = candidates.slice(0, 3).map(file => `${readyPreviewHashes.has(String(file.hash || '')) ? 1 : 0}:${file.hash}:${file.filename}:${file.mime}`).join('|') || 'empty';
  if (strip.dataset.key === key) return;
  strip.dataset.key = key;
  let cursor = 0;
  const nextCell = index => {
    const file = candidates[cursor++] || null;
    return sampleCell(file, index, rejected => {
      if (!rejected.isConnected) return;
      rejected.replaceWith(nextCell(index));
    });
  };
  strip.replaceChildren(...Array.from({ length:3 }, (_, index) => nextCell(index)));
}

function renderFolderPreviews() {
  for (const row of folders?.querySelectorAll(':scope > [data-folder-path]') || []) renderFolderPreview(row);
}

function schedulePreviewRefresh(delay = 1200) {
  if (previewTimer || storagePane?.hidden) return;
  previewTimer = setTimeout(() => {
    previewTimer = 0;
    refreshFolderPreviews(true).catch(() => {});
  }, delay);
}

async function liveSample(path) {
  const data = await request(`/api/client/local-catalog?limit=240&path=${encodeURIComponent(path)}`);
  return { path, files:rankPreviewFiles(data.files).slice(0, 80) };
}

async function refreshReadyPreviewHashes() {
  // Only the three visible cells per source are urgent. Never queue every
  // candidate, then immediately issue doomed image requests for missing files.
  const hashes = [...new Set([...previewSamples.values()].flatMap(sample => previewCandidates(sample?.files).slice(0, 3).map(file => String(file.hash || ''))))];
  if (!hashes.length) return;
  const next = new Set(readyPreviewHashes);
  for (let offset = 0; offset < hashes.length; offset += 500) {
    const batch = hashes.slice(offset, offset + 500);
    try {
      const data = await request('/api/thumbs/check', { method:'POST', body:JSON.stringify({ hashes:batch, background:false }) });
      for (const item of data.thumbnails || []) {
        const hash = String(item?.hash || '');
        if (hash) next.add(hash);
      }
      for (const failure of data.failures || []) if (failure.terminal) failedPreviewHashes.add(String(failure.hash));
    } catch {
      for (const hash of batch) if (readyPreviewHashes.has(hash)) next.add(hash);
    }
  }
  readyPreviewHashes.clear();
  for (const hash of next) readyPreviewHashes.add(hash);
}

async function refreshFolderPreviews(force = false) {
  if (previewLoading || !folders || storagePane?.hidden) return;
  const rows = [...folders.querySelectorAll(':scope > [data-folder-path]')];
  if (!rows.length) return;
  const empty = rows.some(row => !readyPreviewFiles(previewSamples.get(pathKey(row.dataset.folderPath))?.files).length);
  const maxAge = empty ? 1800 : 30_000;
  if (!force && previewLoadedAt && Date.now() - previewLoadedAt < maxAge) {
    renderFolderPreviews();
    if (empty) schedulePreviewRefresh(maxAge);
    return;
  }
  previewLoading = true;
  try {
    const data = await request('/api/client/local-catalog?limit=5');
    previewSamples.clear();
    for (const sample of data.folderSamples || []) previewSamples.set(pathKey(sample.path), { ...sample, files:rankPreviewFiles(sample.files) });
    const weakRows = rows.filter(row => {
      const files = rankPreviewFiles(previewSamples.get(pathKey(row.dataset.folderPath))?.files);
      return files.filter(file => mediaKind(file) === 'image').length < 3;
    });
    if (weakRows.length) {
      const live = await Promise.all(weakRows.map(row => liveSample(row.dataset.folderPath).catch(() => null)));
      for (const sample of live) if (sample?.files?.length) previewSamples.set(pathKey(sample.path), sample);
    }
    await refreshReadyPreviewHashes();
    previewLoadedAt = Date.now();
    renderFolderPreviews();
    const incomplete = rows.some(row => readyPreviewFiles(previewSamples.get(pathKey(row.dataset.folderPath))?.files).length < 3);
    if (incomplete) schedulePreviewRefresh(1200);
  } catch {
    schedulePreviewRefresh(2500);
  } finally { previewLoading = false; }
}

async function annotate() {
  if (annotating) { annotateQueued = true; return; }
  annotating = true; annotateQueued = false;
  try {
    const state = await request('/api/state');
    const configured = state.settings?.folders || [];
    for (const row of folders?.querySelectorAll(':scope > [data-folder-path]') || []) {
      const folder = configured.find(item => samePath(item.path, row.dataset.folderPath));
      if (folder) decorateRow(row, folder);
    }
    refreshFolderPreviews().catch(() => {});
  } catch {}
  finally {
    annotating = false;
    if (annotateQueued) queueMicrotask(annotate);
  }
}

function annotateSoon() {
  if (annotateQueued) return;
  annotateQueued = true;
  queueMicrotask(annotate);
}

async function openLibraryFolder(row) {
  const importId = Number(row?.dataset.folderImportId) || 0;
  if (!importId) throw new Error('This folder is not indexed yet.');
  const child = frame?.contentWindow;
  const library = child?.mochimonoLibrary;
  if (!library?.openFolder) throw new Error('Library is still loading.');
  child.mochimonoHome?.('replace');
  const gridButton = frame.contentDocument?.querySelector('#views [data-view="grid"]');
  if (gridButton && !gridButton.classList.contains('active')) gridButton.click();
  await library.openFolder(importId, '');
  child.scrollTo({ top:0, left:0, behavior:'auto' });
  if (storagePane && !storagePane.hidden) window.mochimonoClientTabs?.show('files');
  child.focus();
}

folders?.addEventListener('click', async event => {
  const open = event.target.closest('[data-open-native-folder-path]');
  if (open) {
    event.preventDefault(); event.stopImmediatePropagation();
    const path = open.dataset.openNativeFolderPath;
    try { await request('/api/open-folder', { method:'POST', body:JSON.stringify({ path }) }); }
    catch (error) { toast(error.message); }
    return;
  }
  const cloud = event.target.closest('[data-protect-folder]');
  if (!cloud) return;
  event.preventDefault(); event.stopImmediatePropagation(); cloud.disabled = true;
  try {
    await request('/api/browse-folders/protect', { method:'POST', body:JSON.stringify({ path:cloud.dataset.protectFolder }) });
    previewLoadedAt = 0; annotateSoon(); setTimeout(refreshLibrary, 250);
  } catch (error) { toast(error.message); }
  finally { cloud.disabled = false; }
}, true);

if (folders) {
  new MutationObserver(records => {
    if (!records.some(record => record.addedNodes.length || record.removedNodes.length)) return;
    if (storagePane) new MutationObserver(() => {
  if (storagePane.hidden) return;
  renderFolderPreviews();
  refreshFolderPreviews(true).catch(() => {});
}).observe(storagePane, { attributes:true, attributeFilter:['hidden'] });

window.addEventListener('message', event => {
  if (event.source !== frame?.contentWindow || event.origin !== location.origin || event.data?.type !== 'mochimono-local-catalog-event' || storagePane?.hidden) return;
  const needsPreviews = [...folders.querySelectorAll(':scope > [data-folder-path]')].some(row => readyPreviewFiles(previewSamples.get(pathKey(row.dataset.folderPath))?.files).length < 3);
  if (needsPreviews) schedulePreviewRefresh(600);
});

annotateSoon();
  }).observe(folders, { childList:true });
}

annotateSoon();