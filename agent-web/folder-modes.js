const folders = document.querySelector('#folders');
const frame = document.querySelector('#filesFrame');

let annotating = false;
let annotateQueued = false;
let previewLoading = false;
let previewLoadedAt = 0;
let previewTimer = 0;
let emptyPreviewRetries = 0;
const previewSamples = new Map();

const style = document.createElement('style');
style.textContent = `
  .storage-folder-samples{
    width:260px;height:140px;display:grid;
    grid-template-columns:1.55fr 1fr 1fr;grid-template-rows:1fr 1fr;
    gap:3px;overflow:hidden;border-radius:13px;background:#0a090b;cursor:pointer
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
    content:'▶';position:absolute;left:7px;bottom:6px;width:22px;height:22px;
    display:grid;place-items:center;border-radius:50%;background:rgba(0,0,0,.62);
    color:#fff;font-size:8px;padding-left:1px
  }
  .storage-folder-samples:hover{outline:1px solid rgba(255,255,255,.18);outline-offset:1px}
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

function renderLocationBadge(row, cloud) {
  let badges = row.querySelector('[data-folder-mode]');
  if (!cloud) {
    badges?.remove();
    return;
  }
  if (!badges) {
    badges = document.createElement('span');
    badges.dataset.folderMode = '';
    row.querySelector('.storage-title strong')?.after(badges);
  }
  badges.className = 'storage-modes';
  if (badges.textContent !== 'Cloud') badges.textContent = 'Cloud';
  badges.title = 'Cloud copy';
}

function decorateRow(row, folder) {
  const cloud = folder.protected !== false;
  row.classList.toggle('browse-only-folder', !cloud);
  row.classList.toggle('cloud-folder', cloud);
  renderPath(row, folder.path);
  renderLocationBadge(row, cloud);

  const actions = row.querySelector('.item-actions');
  const sync = actions?.querySelector('[data-sync-folder]');
  if (sync) {
    sync.textContent = cloud ? 'Sync' : 'Index';
    sync.title = cloud ? 'Sync now' : 'Re-index';
  }

  let open = actions?.querySelector('[data-open-native-folder]');
  if (actions && !open) {
    open = document.createElement('button');
    open.type = 'button';
    open.className = 'action-link';
    open.dataset.openNativeFolder = '';
    open.textContent = 'Open';
    actions.prepend(open);
  }
  if (open) {
    open.dataset.path = folder.path;
    open.title = 'Show in folder';
  }

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

function sampleGlyph(file) {
  const mime = String(file?.mime || '');
  if (mime.startsWith('video/')) return '▶';
  if (mime.startsWith('audio/')) return '♪';
  if (mime.startsWith('image/')) return '▧';
  return '▤';
}

function thumbUrl(hash, attempt = 0) {
  const suffix = attempt ? `?storage=${attempt}&t=${Date.now()}` : '';
  return `/api/thumbs/${encodeURIComponent(hash)}${suffix}`;
}

function installThumb(img, cell, hash) {
  const delays = [450, 800, 1300, 2200, 3600, 5600, 8500];
  img.addEventListener('load', () => cell.classList.add('thumb-ready'));
  img.addEventListener('error', () => {
    cell.classList.remove('thumb-ready');
    const attempt = Number(img.dataset.attempt || 0);
    if (attempt >= delays.length) return;
    img.dataset.attempt = String(attempt + 1);
    setTimeout(() => {
      if (img.isConnected) img.src = thumbUrl(hash, attempt + 1);
    }, delays[attempt]);
  });
}

function sampleCell(file, index) {
  const cell = document.createElement('span');
  cell.className = 'storage-folder-sample';
  if (!file) {
    if (index === 0) {
      const glyph = document.createElement('span');
      glyph.className = 'sample-glyph';
      glyph.textContent = '▱';
      cell.append(glyph);
    }
    return cell;
  }

  const filename = String(file.filename || '');
  const mime = String(file.mime || '');
  cell.title = filename;
  if (mime.startsWith('video/')) cell.classList.add('video');

  const glyph = document.createElement('span');
  glyph.className = 'sample-glyph';
  glyph.textContent = sampleGlyph(file);
  const name = document.createElement('small');
  name.className = 'sample-name';
  name.textContent = filename;
  cell.append(glyph, name);

  const media = mime.startsWith('image/') || mime.startsWith('video/');
  const hash = String(file.hash || '');
  if (media && /^[a-f0-9]{64}$/.test(hash)) {
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.dataset.attempt = '0';
    installThumb(img, cell, hash);
    img.src = thumbUrl(hash);
    cell.append(img);
  }
  return cell;
}

function renderFolderPreview(row) {
  const sample = previewSamples.get(pathKey(row.dataset.folderPath));
  const files = sample?.files || [];
  let strip = row.querySelector('.storage-folder-samples');
  if (!strip) {
    strip = document.createElement('div');
    strip.className = 'storage-folder-samples';
    row.prepend(strip);
  }
  row.classList.add('has-folder-preview');
  strip.dataset.openNativeFolderPath = row.dataset.folderPath || '';
  strip.title = 'Show in folder';

  const key = files.slice(0, 5).map(file => `${file.hash}:${file.filename}:${file.mime}`).join('|') || 'empty';
  if (strip.dataset.key === key) return;
  strip.dataset.key = key;
  strip.replaceChildren(...Array.from({ length:5 }, (_, index) => sampleCell(files[index], index)));
}

function renderFolderPreviews() {
  for (const row of folders?.querySelectorAll(':scope > [data-folder-path]') || []) renderFolderPreview(row);
}

function schedulePreviewRefresh(delay = 1600) {
  if (emptyPreviewRetries >= 8) return;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => refreshFolderPreviews(true).catch(() => {}), delay);
}

async function liveSample(path) {
  const data = await request(`/api/client/local-catalog?limit=5&path=${encodeURIComponent(path)}`);
  return { path, files:Array.isArray(data.files) ? data.files.slice(0, 5) : [] };
}

async function refreshFolderPreviews(force = false) {
  if (previewLoading || !folders) return;
  const rows = [...folders.querySelectorAll(':scope > [data-folder-path]')];
  if (!rows.length) return;
  const missing = rows.some(row => {
    const sample = previewSamples.get(pathKey(row.dataset.folderPath));
    return !sample || !sample.files?.length;
  });
  const maxAge = missing ? 1800 : 30_000;
  if (!force && previewLoadedAt && Date.now() - previewLoadedAt < maxAge) {
    renderFolderPreviews();
    if (missing) schedulePreviewRefresh(maxAge);
    return;
  }

  previewLoading = true;
  try {
    const data = await request('/api/client/local-catalog?limit=5');
    previewSamples.clear();
    for (const sample of data.folderSamples || []) previewSamples.set(pathKey(sample.path), sample);

    // The combined sample list is intentionally cached by the Agent. If a folder
    // was sampled while its first index was still empty, ask that folder's live
    // catalog directly so the Storage mosaic does not wait for that cache to age out.
    const blankRows = rows.filter(row => !(previewSamples.get(pathKey(row.dataset.folderPath))?.files?.length));
    if (blankRows.length) {
      const live = await Promise.all(blankRows.map(row =>
        liveSample(row.dataset.folderPath).catch(() => null)
      ));
      for (const sample of live) {
        if (sample?.files?.length) previewSamples.set(pathKey(sample.path), sample);
      }
    }

    previewLoadedAt = Date.now();
    renderFolderPreviews();
    const stillEmpty = rows.some(row => !(previewSamples.get(pathKey(row.dataset.folderPath))?.files?.length));
    if (stillEmpty) {
      emptyPreviewRetries++;
      schedulePreviewRefresh(1800);
    } else {
      emptyPreviewRetries = 0;
    }
  } catch {
    emptyPreviewRetries++;
    schedulePreviewRefresh(2500);
  } finally {
    previewLoading = false;
  }
}

async function annotate() {
  if (annotating) {
    annotateQueued = true;
    return;
  }
  annotating = true;
  annotateQueued = false;
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

folders?.addEventListener('click', async event => {
  const open = event.target.closest('[data-open-native-folder],[data-open-native-folder-path]');
  if (open) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const path = open.dataset.path || open.dataset.openNativeFolderPath;
    try {
      await request('/api/open-folder', { method:'POST', body:JSON.stringify({ path }) });
    } catch (error) {
      toast(error.message);
    }
    return;
  }

  const cloud = event.target.closest('[data-protect-folder]');
  if (!cloud) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  cloud.disabled = true;
  try {
    await request('/api/browse-folders/protect', {
      method:'POST', body:JSON.stringify({ path:cloud.dataset.protectFolder })
    });
    previewLoadedAt = 0;
    emptyPreviewRetries = 0;
    annotateSoon();
    setTimeout(refreshLibrary, 250);
  } catch (error) {
    toast(error.message);
  } finally {
    cloud.disabled = false;
  }
}, true);

if (folders) {
  new MutationObserver(records => {
    if (!records.some(record => record.addedNodes.length || record.removedNodes.length)) return;
    emptyPreviewRetries = 0;
    annotateSoon();
  }).observe(folders, { childList:true });
}

annotateSoon();
