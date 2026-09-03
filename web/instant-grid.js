const CLIENT = document.documentElement.classList.contains('client-library');
const files = document.querySelector('#files');
const app = document.querySelector('#app');
const login = document.querySelector('#login');
const fileCount = document.querySelector('#fileCount');
const typeFilter = document.querySelector('#typeFilter');
const THUMB_VERSION = 3;
const QUICK_LIMIT = 160;

if (CLIENT && files && app && !new URL(location.href).searchParams.has('file')) paintInstantGrid().catch(() => {});

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
    image.hidden = true;
    image.decoding = 'async';
    image.loading = 'eager';
    image.onload = () => {
      if (!image.isConnected) return;
      image.hidden = false;
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

function filterQuick(items) {
  const type = String(typeFilter?.value || '');
  if (!type) return items;
  if (type === 'media') return items.filter(file => mediaKind(file));
  if (type === 'image') return items.filter(file => mediaKind(file) === 'image');
  if (type === 'video') return items.filter(file => mediaKind(file) === 'video');
  return items;
}

async function paintInstantGrid() {
  // Omit pagination so the Agent may include rows still in its progressive
  // in-memory staging window during a first-time local index.
  const response = await fetch(`/api/client/local-catalog?limit=${QUICK_LIMIT}`, { cache:'no-store' });
  if (!response.ok) return;
  const data = await response.json();

  // library-app publishes its API before its expensive catalog restore finishes,
  // so detect real rendered cards rather than the existence of that API.
  if (files.querySelector('[data-hash]')) return;
  const items = filterQuick(Array.isArray(data.files) ? data.files : []).slice(0, QUICK_LIMIT);
  if (!items.length) return;

  document.documentElement.classList.add('instant-grid-preview');
  files.className = 'files grid';
  files.innerHTML = markup(items);
  login.hidden = true;
  app.hidden = false;
  if (fileCount) fileCount.textContent = 'Loading library…';
  installThumbnailHandoff();
  installReadyThumbs();
}

const style = document.createElement('style');
style.textContent = `html.instant-grid-preview #files .instant-grid-card{pointer-events:none}`;
document.head.append(style);
