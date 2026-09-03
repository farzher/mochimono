const CLIENT = document.documentElement.classList.contains('client-library');
const files = document.querySelector('#files');
const app = document.querySelector('#app');
const login = document.querySelector('#login');
const fileCount = document.querySelector('#fileCount');
const typeFilter = document.querySelector('#typeFilter');
const THUMB_VERSION = 3;
const QUICK_LIMIT = 160;
const QUICK_SCAN_LIMIT = 5000;
const CACHE_DB = 'mochimono-library';
const CACHE_META_KEY = 'catalog';
const QUICK_TYPE_KEY = 'mochimono-quick-type';

if (typeFilter) typeFilter.addEventListener('change', () => {
  try { localStorage.setItem(QUICK_TYPE_KEY, String(typeFilter.value || '')); } catch {}
});

if (CLIENT) {
  let lastActivity = 0;
  const noteActivity = () => {
    const now = Date.now();
    if (now - lastActivity < 1400) return;
    lastActivity = now;
    fetch('/api/thumbnail-activity', { method:'POST', keepalive:true }).catch(() => {});
  };
  for (const type of ['pointerdown','keydown','wheel','touchstart']) addEventListener(type, noteActivity, { passive:true, capture:true });
  addEventListener('scroll', noteActivity, { passive:true });
  noteActivity();
}

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
const mediaKind = file => String(file?.mime || '').startsWith('image/') ? 'image' : String(file?.mime || '').startsWith('video/') ? 'video' : '';

function formatBytes(bytes) {
  const units = ['B','KB','MB','GB','TB'];
  let value = Number(bytes) || 0;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return `${value < 10 && unit ? value.toFixed(2) : value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function fileDate(file) {
  const date = new Date(file.fileDate || file.createdAt || 0);
  return Number.isNaN(date.getTime()) ? new Date(0) : date;
}

function monthKey(file) {
  const date = fileDate(file);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function groups(items) {
  const result = [];
  for (const file of items) {
    const date = fileDate(file);
    const key = monthKey(file);
    const last = result.at(-1);
    if (last?.key === key) last.files.push(file);
    else result.push({ key, year: date.getFullYear(), month: date.toLocaleDateString(undefined, { month:'long' }), files:[file] });
  }
  return result;
}

function card(file) {
  const kind = mediaKind(file);
  const media = Boolean(kind);
  const ratio = file.width && file.height ? Math.max(.65, Math.min(2.1, Number(file.width) / Number(file.height))) : 4 / 3;
  if (media) {
    return `<div class="file-card media-card ${kind === 'video' ? 'video-card' : ''} instant-grid-card" data-instant-hash="${file.hash}" data-width="${Number(file.width) || 0}" data-height="${Number(file.height) || 0}" style="--ratio:${ratio}" aria-hidden="true"><div class="thumb media-thumb"><span class="video-thumb-pending"></span>${kind === 'video' ? '<span class="play-badge">▶</span>' : ''}</div></div>`;
  }
  const label = String(file.mime || '').startsWith('audio/') ? '♪' : String(file.mime || '').startsWith('text/') || String(file.mime || '').startsWith('application/') ? '▤' : '·';
  return `<div class="file-card instant-grid-card" aria-hidden="true"><div class="thumb"><div class="file-icon">${label}</div></div><div class="card-copy"><strong>${escapeHtml(file.filename || '')}</strong><span>${formatBytes(file.size)}</span></div></div>`;
}

function markup(items) {
  let previousYear = null;
  return groups(items).map(group => {
    const year = group.year === previousYear ? '' : `<h2 class="year-heading">${group.year}</h2>`;
    previousYear = group.year;
    return `<section class="date-group instant-grid-group" data-date-group="${group.key}" data-year="${group.year}">${year}<h3 class="date-heading">${escapeHtml(group.month)}</h3><div class="date-grid">${group.files.map(card).join('')}</div></section>`;
  }).join('');
}

function currentQuickType() {
  const query = String(new URL(location.href).searchParams.get('type') || '');
  if (query) return query;
  try { return String(localStorage.getItem(QUICK_TYPE_KEY) || typeFilter?.value || ''); }
  catch { return String(typeFilter?.value || ''); }
}

function matchesQuickType(file, wanted = currentQuickType()) {
  if (!wanted) return true;
  const kind = mediaKind(file);
  if (wanted === 'media') return Boolean(kind);
  if (wanted === 'image' || wanted === 'video') return kind === wanted;
  const mime = String(file?.mime || '');
  if (wanted === 'audio') return mime.startsWith('audio/');
  if (wanted === 'application') return mime.startsWith('application/') || mime.startsWith('text/');
  if (wanted === 'other') return !/^(?:image|video|audio|application|text)\//.test(mime);
  return true;
}

function filterQuick(items) {
  const wanted = currentQuickType();
  return wanted ? items.filter(file => matchesQuickType(file, wanted)) : items;
}

function openQuickCache() {
  if (!('indexedDB' in window)) return Promise.resolve(null);
  return new Promise(resolve => {
    let request;
    try { request = indexedDB.open(CACHE_DB); }
    catch { return resolve(null); }
    request.onupgradeneeded = () => {
      try { request.transaction?.abort(); } catch {}
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

async function cachedQuickFiles() {
  const db = await openQuickCache();
  if (!db) return [];
  try {
    if (!db.objectStoreNames.contains('meta') || !db.objectStoreNames.contains('files')) return [];
    const wanted = currentQuickType();
    return await new Promise(resolve => {
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      let transaction;
      try { transaction = db.transaction(['meta','files'], 'readonly'); }
      catch { return finish([]); }
      transaction.onerror = () => finish([]);
      transaction.onabort = () => finish([]);

      const metaRequest = transaction.objectStore('meta').get(CACHE_META_KEY);
      metaRequest.onerror = () => finish([]);
      metaRequest.onsuccess = () => {
        const meta = metaRequest.result;
        if (!meta?.version) return finish([]);
        if (Array.isArray(meta.quickFiles) && meta.quickFiles.length) {
          return finish(meta.quickFiles.filter(file => matchesQuickType(file, wanted)).slice(0, QUICK_LIMIT));
        }

        // Compatibility for an existing cache written before quickFiles existed.
        // It is intentionally bounded; the next normal cache save persists a
        // direct first-page snapshot and future reloads avoid this cursor walk.
        const result = [];
        let scanned = 0;
        const cursorRequest = transaction.objectStore('files').openCursor();
        cursorRequest.onerror = () => finish(result);
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor || result.length >= QUICK_LIMIT || scanned >= QUICK_SCAN_LIMIT) return finish(result);
          scanned++;
          const file = cursor.value;
          if (file?.__snapshot === meta.version && /^[a-f0-9]{64}$/.test(String(file.hash || '')) && matchesQuickType(file, wanted)) result.push(file);
          cursor.continue();
        };
      };
    });
  } finally {
    try { db.close(); } catch {}
  }
}

async function serverQuickFiles() {
  try {
    let response = await fetch(`/api/client/local-catalog?limit=${QUICK_LIMIT}&offset=0`, { cache:'no-store' });
    if (!response.ok) return [];
    let data = await response.json();
    if (Array.isArray(data.files) && data.files.length) return filterQuick(data.files).slice(0, QUICK_LIMIT);

    response = await fetch(`/api/client/local-catalog?limit=${QUICK_LIMIT}`, { cache:'no-store' });
    if (!response.ok) return [];
    data = await response.json();
    return filterQuick(Array.isArray(data.files) ? data.files : []).slice(0, QUICK_LIMIT);
  } catch {
    return [];
  }
}

function installThumbnailHandoff() {
  const observer = new MutationObserver(records => {
    const ready = new Map();
    for (const record of records) {
      for (const node of record.removedNodes) {
        if (!(node instanceof Element)) continue;
        const cards = [];
        if (node.matches('[data-instant-hash]')) cards.push(node);
        cards.push(...node.querySelectorAll('[data-instant-hash]'));
        for (const card of cards) {
          const image = card.querySelector('img.cached-thumb:not([hidden])');
          if (image?.complete && image.naturalWidth) ready.set(String(card.dataset.instantHash || ''), image);
        }
      }
    }

    if (ready.size) {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          const cards = [];
          if (node.matches('[data-hash]')) cards.push(node);
          cards.push(...node.querySelectorAll('[data-hash]'));
          for (const card of cards) {
            const image = ready.get(String(card.dataset.hash || ''));
            const box = image && card.querySelector('.media-thumb');
            if (!box || box.querySelector('img.cached-thumb')) continue;
            box.querySelector('.video-thumb-pending')?.remove();
            box.prepend(image);
          }
        }
      }
    }

    if (files.querySelector('[data-hash]')) {
      document.documentElement.classList.remove('instant-grid-preview');
      observer.disconnect();
    }
  });
  observer.observe(files, { childList:true, subtree:true });
  setTimeout(() => {
    observer.disconnect();
    document.documentElement.classList.remove('instant-grid-preview');
  }, 30_000);
}

function installReadyThumbs() {
  const hashes = [];
  for (const card of files.querySelectorAll('[data-instant-hash]')) {
    const hash = String(card.dataset.instantHash || '');
    if (!/^[a-f0-9]{64}$/.test(hash)) continue;
    hashes.push(hash);
    const box = card.querySelector('.media-thumb');
    const image = document.createElement('img');
    image.className = 'cached-thumb';
    image.alt = '';
    image.hidden = false;
    image.decoding = 'async';
    image.loading = 'eager';
    image.onload = () => {
      if (!image.isConnected) return;
      box?.querySelector('.video-thumb-pending')?.remove();
    };
    image.onerror = () => image.remove();
    box?.prepend(image);
    image.src = `/api/thumbs/${hash}?v=${THUMB_VERSION}`;
  }

  if (hashes.length) fetch('/api/thumbs/check', {
    method: 'POST',
    headers: { 'content-type':'application/json' },
    body: JSON.stringify({ hashes: hashes.slice(0, 500) })
  }).catch(() => {});
}

function paint(items) {
  if (files.querySelector('[data-hash]') || !items.length) return false;
  items.sort((a, b) => fileDate(b).getTime() - fileDate(a).getTime());
  document.documentElement.classList.add('instant-grid-preview');
  files.className = 'files grid';
  files.innerHTML = markup(items.slice(0, QUICK_LIMIT));
  login.hidden = true;
  app.hidden = false;
  if (fileCount) fileCount.textContent = 'Loading library…';
  installThumbnailHandoff();
  installReadyThumbs();
  return true;
}

const afterPaint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

async function paintInstantGrid() {
  const cached = await cachedQuickFiles();
  if (paint(cached)) {
    // Do not let catalog-cache.js immediately monopolize the same frame with its
    // full IndexedDB getAll + 90k-file hydration. Give this useful grid a paint.
    await afterPaint();
    return true;
  }

  // A cold/legacy cache should not hold up the real library on a network request.
  // Let the server quick page race independently while normal hydration starts.
  serverQuickFiles().then(items => paint(items)).catch(() => {});
  return false;
}

if (CLIENT && files && app && !new URL(location.href).searchParams.has('file')) {
  window.mochimonoInstantGridReady = paintInstantGrid().catch(() => false);
} else {
  window.mochimonoInstantGridReady = Promise.resolve(false);
}

const style = document.createElement('style');
style.textContent = `html.instant-grid-preview #files .instant-grid-card{pointer-events:none}`;
document.head.append(style);
