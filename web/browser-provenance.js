const DB_NAME = 'mochimono-browser-folders';
const DB_VERSION = 1;
const SOURCES = 'sources';
const FILES = 'files';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SOURCES)) db.createObjectStore(SOURCES, { keyPath:'id' });
      if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES, { keyPath:'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function all(store) {
  return new Promise((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

function fullPath(source) {
  const relative = String(source?.path || '').replace(/^[\\/]+/, '');
  const root = String(source?.rootPath || '').replace(/[\\/]+$/, '');
  if (!root) return relative;
  if (!relative) return root;
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  return `${root}${separator}${relative.replace(/[\\/]+/g, separator)}`;
}

function parentPath(value) {
  const raw = String(value || '').replace(/[\\/]+$/, '');
  const index = Math.max(raw.lastIndexOf('\\'), raw.lastIndexOf('/'));
  return index > 1 ? raw.slice(0, index) : raw;
}

function currentHash() {
  return document.querySelector('#viewer-open')?.getAttribute('href')?.match(/\/api\/objects\/([a-f0-9]{64})/)?.[1] || '';
}

export async function browserSourcesForHash(hash) {
  if (!/^[a-f0-9]{64}$/.test(String(hash || ''))) return [];
  let db;
  try {
    db = await openDb();
    const tx = db.transaction([SOURCES, FILES], 'readonly');
    const [sources, files] = await Promise.all([all(tx.objectStore(SOURCES)), all(tx.objectStore(FILES))]);
    const byId = new Map(sources.map(source => [String(source.id || ''), source]));
    const result = [];
    for (const row of files) {
      if (String(row.hash || '') !== String(hash)) continue;
      const separator = String(row.key || '').indexOf('\u0000');
      const id = separator >= 0 ? String(row.key).slice(0, separator) : '';
      const source = byId.get(id);
      if (!source) continue;
      result.push({
        browser:true,
        browserSourceId:id,
        sourceName:source.name || 'Browser folder',
        deviceName:`Browser · ${source.name || 'Folder'}`,
        rootPath:source.rootPath || source.name || '',
        path:row.path || '',
        filename:String(row.path || '').split('/').at(-1) || row.path || '',
        mtime:Number(row.lastModified) || 0,
        importedAt:source.createdAt || '',
        cloud:Boolean(source.cloud && row.cloudSynced)
      });
    }
    return result;
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

const viewer = document.querySelector('#viewer');
const viewerOpen = document.querySelector('#viewer-open');
const viewerContext = document.querySelector('#viewer-context');
const panel = document.querySelector('#viewerInfo');
const cache = new Map();
let scheduled = false;

function sourcePromise(hash) {
  if (!cache.has(hash)) cache.set(hash, browserSourcesForHash(hash));
  return cache.get(hash);
}

function addHeaderSource(source) {
  if (!viewerContext) return;
  const folder = parentPath(fullPath(source));
  if (!folder) return;
  const duplicate = [...viewerContext.querySelectorAll('[data-context-value]')]
    .some(node => String(node.dataset.contextValue || '').toLowerCase() === folder.toLowerCase());
  if (duplicate) return;
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'viewer-context-chip path';
  chip.dataset.contextKind = 'path';
  chip.dataset.contextValue = folder;
  chip.dataset.browserProvenance = '1';
  chip.textContent = source.deviceName;
  chip.title = `${folder}\nBrowser folder · Filter to this folder`;
  viewerContext.append(chip);
}

function removeEmpty(section) {
  section?.querySelectorAll(':scope > .viewer-info-empty').forEach(node => node.remove());
}

function renderWhere(sources, hash) {
  if (!panel || panel.hidden || !sources.length) return;
  const section = [...panel.querySelectorAll('.viewer-info-section')]
    .find(node => node.querySelector(':scope > h3')?.textContent.trim() === 'Where');
  if (!section) return;
  removeEmpty(section);
  const grouped = new Map();
  for (const source of sources) {
    const key = source.browserSourceId || source.deviceName;
    if (!grouped.has(key)) grouped.set(key, { source, paths:[] });
    grouped.get(key).paths.push(fullPath(source));
  }
  for (const [key, item] of grouped) {
    if (section.querySelector(`[data-browser-provenance="${CSS.escape(`${hash}:${key}`)}"]`)) continue;
    const article = document.createElement('article');
    article.className = 'viewer-copy';
    article.dataset.browserProvenance = `${hash}:${key}`;
    const head = document.createElement('div');
    head.className = 'viewer-copy-head';
    const strong = document.createElement('strong');
    strong.textContent = item.source.deviceName;
    const kind = document.createElement('span');
    kind.textContent = item.source.cloud ? 'Browser folder · Local + Cloud' : 'Browser folder · Local';
    head.append(strong, kind);
    article.append(head);
    for (const path of [...new Set(item.paths.filter(Boolean))]) {
      const row = document.createElement('div');
      row.className = 'viewer-info-path';
      row.title = path;
      row.textContent = path;
      article.append(row);
    }
    section.append(article);
  }
}

function renderOrigins(sources, hash) {
  if (!panel || panel.hidden || !sources.length) return;
  const section = panel.querySelector('.viewer-origins');
  if (!section) return;
  removeEmpty(section);
  for (const source of sources) {
    const path = fullPath(source);
    const key = `${hash}:${source.browserSourceId}:${path}`;
    if (section.querySelector(`[data-browser-provenance="${CSS.escape(key)}"]`)) continue;
    const article = document.createElement('article');
    article.className = 'viewer-origin';
    article.dataset.browserProvenance = key;
    const strong = document.createElement('strong');
    strong.textContent = source.deviceName;
    article.append(strong);
    if (path) {
      const row = document.createElement('div');
      row.className = 'viewer-info-path';
      row.title = path;
      row.textContent = path;
      article.append(row);
    }
    const small = document.createElement('small');
    small.textContent = 'Browser folder';
    article.append(small);
    section.append(article);
  }
}

async function syncViewer() {
  scheduled = false;
  const hash = currentHash();
  if (!hash || viewer?.hidden) return;
  const sources = await sourcePromise(hash);
  if (hash !== currentHash() || viewer?.hidden || !sources.length) return;
  for (const source of sources) addHeaderSource(source);
  renderWhere(sources, hash);
  renderOrigins(sources, hash);
}

function scheduleViewerSync() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => syncViewer().catch(() => {}));
}

viewerOpen && new MutationObserver(scheduleViewerSync).observe(viewerOpen, { attributes:true, attributeFilter:['href'] });
viewerContext && new MutationObserver(scheduleViewerSync).observe(viewerContext, { childList:true });
panel && new MutationObserver(scheduleViewerSync).observe(panel, { childList:true, subtree:true, attributes:true, attributeFilter:['hidden'] });
viewer && new MutationObserver(scheduleViewerSync).observe(viewer, { attributes:true, attributeFilter:['hidden'] });

for (const eventName of ['mochimono:browser-folders-changed', 'mochimono:browser-folder-sync']) {
  addEventListener(eventName, () => {
    cache.clear();
    scheduleViewerSync();
  });
}

window.mochimonoBrowserProvenance = { sourcesForHash:browserSourcesForHash };
scheduleViewerSync();
