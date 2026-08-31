const files = document.querySelector('#files');
const views = document.querySelector('#views');
const source = document.querySelector('#source');
const viewer = document.querySelector('#viewer');
const viewerClose = document.querySelector('#viewer-close');
const viewerInfo = document.querySelector('#viewer-info-button');
const mediaSizeControl = document.querySelector('#mediaSizeControl');
const CACHE_NAME = 'mochimono-catalog';
const CACHE_VERSION = 2;
const CONTEXT_KEY = 'mochimono-grid-context';

let contextEnabled = localStorage.getItem(CONTEXT_KEY) !== '0';
let fileInfo = new Map();
let sourceNames = new Map();
let cachePromise = null;
let decorateFrame = 0;
let hoverTimer = 0;
let hoverHash = '';
let lastFocusedHash = '';
const detailCache = new Map();

const style = document.createElement('style');
style.textContent = `
  .grid-context-toggle{width:34px;height:34px;padding:0;display:grid;place-items:center;background:#111013;color:#82797a;border-radius:10px}
  .grid-context-toggle:hover{background:var(--surface2);color:#ddd4d0}
  .grid-context-toggle.active{background:var(--surface3);color:#fff}
  .grid-context-toggle span{width:16px;height:16px;display:grid;place-items:center;border:1.5px solid currentColor;border-radius:50%;font:800 10px/1 system-ui}
  .file-card.media-card{position:relative}
  .file-context-badge{position:absolute;z-index:3;left:5px;right:5px;bottom:5px;min-width:0;padding:4px 6px;border-radius:5px;background:rgba(7,7,8,.68);backdrop-filter:blur(5px);color:#e4ddda;font-size:9px;font-weight:650;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;text-shadow:0 1px 2px #000;opacity:.78;transition:opacity .12s}
  .file-card.media-card:hover .file-context-badge,.file-card.media-card:focus .file-context-badge{opacity:1}
  .file-card.context-keyboard-focus{box-shadow:0 0 0 3px rgba(239,160,154,.9)!important;outline:none}
  .file-context-tooltip{position:fixed;z-index:80;width:min(390px,calc(100vw - 24px));padding:10px 11px;border:1px solid #3b363b;border-radius:10px;background:rgba(27,25,28,.97);box-shadow:0 12px 38px rgba(0,0,0,.46);color:#f3ece8;pointer-events:none;font-size:11px;line-height:1.35}
  .file-context-tooltip[hidden]{display:none}
  .file-context-tooltip strong{display:block;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .file-context-tooltip .context-summary{margin-top:3px;color:#aaa09d;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .file-context-tooltip .context-section{margin-top:8px;padding-top:7px;border-top:1px solid #393438}
  .file-context-tooltip .context-location{margin-top:5px;min-width:0}
  .file-context-tooltip .context-location b{display:block;color:#d4cac6;font-size:10px}
  .file-context-tooltip .context-location span{display:block;color:#918885;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .file-context-tooltip .context-collections{color:#c9b2d8}
  @media(hover:none){.file-context-tooltip{display:none!important}.file-context-badge{font-size:8px}}
`;
document.head.append(style);

const toggle = document.createElement('button');
toggle.type = 'button';
toggle.className = 'grid-context-toggle';
toggle.title = 'Show file context';
toggle.setAttribute('aria-label', 'Show file context');
toggle.innerHTML = '<span aria-hidden="true">i</span>';
mediaSizeControl.after(toggle);

const tooltip = document.createElement('div');
tooltip.className = 'file-context-tooltip';
tooltip.hidden = true;
document.body.append(tooltip);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function currentView() {
  return views.querySelector('[data-view].active')?.dataset.view || 'grid';
}

function importIds(file) {
  return Array.isArray(file?.importIds)
    ? file.importIds.map(Number).filter(Boolean)
    : String(file?.importIds || '').split(',').map(Number).filter(Boolean);
}

function normalizePath(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
}

function dirname(value) {
  const path = normalizePath(value);
  const parts = path.split('/').filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join('/') : '';
}

function pathTail(value, count = 2) {
  const parts = normalizePath(value).split('/').filter(Boolean);
  return parts.slice(-count).join(' / ');
}

function briefContext(file) {
  if (!file) return '';
  const ids = importIds(file);
  const names = [...new Set(ids.map(id => sourceNames.get(id)).filter(Boolean))];
  const folder = pathTail(dirname(file.originalPath), 2);
  if (names.length === 1 && folder) return `${names[0]} · ${folder}`;
  if (folder) return folder;
  if (names.length === 1) return names[0];
  if (names.length > 1) return `${names.length} sources`;
  return 'No folder context';
}

function openCache() {
  if (!('indexedDB' in window)) return Promise.resolve(null);
  if (!cachePromise) cachePromise = new Promise(resolve => {
    const request = indexedDB.open(CACHE_NAME, CACHE_VERSION);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
  return cachePromise;
}

async function refreshCache() {
  const db = await openCache();
  if (!db) return;
  const transaction = db.transaction(['files', 'meta']);
  const fileRequest = transaction.objectStore('files').getAll();
  const metaRequest = transaction.objectStore('meta').get('catalog');
  const [records, meta] = await Promise.all([
    new Promise(resolve => { fileRequest.onsuccess = () => resolve(fileRequest.result || []); fileRequest.onerror = () => resolve([]); }),
    new Promise(resolve => { metaRequest.onsuccess = () => resolve(metaRequest.result || null); metaRequest.onerror = () => resolve(null); })
  ]);
  fileInfo = new Map(records.map(file => [file.hash, file]));
  sourceNames = new Map((meta?.imports || []).map(item => [Number(item.id), String(item.sourceName || '')]));
  scheduleDecorate();
}

function syncToggle() {
  const grid = currentView() === 'grid';
  toggle.hidden = !grid;
  toggle.classList.toggle('active', contextEnabled);
  toggle.setAttribute('aria-pressed', String(contextEnabled));
}

function decorate() {
  decorateFrame = 0;
  syncToggle();
  const grid = currentView() === 'grid';
  for (const card of files.querySelectorAll('.file-card.media-card[data-hash]')) {
    let badge = card.querySelector('.file-context-badge');
    if (!grid || !contextEnabled) {
      badge?.remove();
      continue;
    }
    const file = fileInfo.get(card.dataset.hash);
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'file-context-badge';
      card.append(badge);
    }
    badge.textContent = briefContext(file) || card.title || '';
    if (lastFocusedHash === card.dataset.hash) card.classList.add('context-keyboard-focus');
    else card.classList.remove('context-keyboard-focus');
  }
}

function scheduleDecorate() {
  if (!decorateFrame) decorateFrame = requestAnimationFrame(decorate);
}

function fullPath(item) {
  const relative = String(item?.path || '');
  const root = String(item?.rootPath || '').replace(/[\\/]+$/, '');
  if (!root) return relative;
  const separator = root.includes('\\') ? '\\' : '/';
  return `${root}${separator}${relative.replace(/[\\/]+/g, separator)}`;
}

function tooltipBase(hash) {
  const file = fileInfo.get(hash);
  const card = files.querySelector(`[data-hash="${CSS.escape(hash)}"]`);
  const name = file?.filename || card?.title || 'File';
  return `<strong>${escapeHtml(name)}</strong><div class="context-summary">${escapeHtml(briefContext(file))}</div>`;
}

async function loadDetails(hash) {
  if (detailCache.has(hash)) return detailCache.get(hash);
  const promise = Promise.allSettled([
    fetch(`/api/provenance/${hash}`).then(response => response.ok ? response.json() : null),
    fetch(`/api/collections/file/${hash}`).then(response => response.ok ? response.json() : null)
  ]).then(([provenance, collections]) => ({
    provenance: provenance.status === 'fulfilled' ? provenance.value : null,
    collections: collections.status === 'fulfilled' ? collections.value : null
  }));
  detailCache.set(hash, promise);
  return promise;
}

function positionTooltip(card) {
  const rect = card.getBoundingClientRect();
  const width = Math.min(390, innerWidth - 24);
  const preferRight = rect.right + width + 12 <= innerWidth;
  const left = preferRight ? rect.right + 8 : Math.max(12, Math.min(innerWidth - width - 12, rect.left));
  const top = Math.max(12, Math.min(innerHeight - tooltip.offsetHeight - 12, rect.top));
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

async function showTooltip(card) {
  if (currentView() !== 'grid') return;
  const hash = card?.dataset.hash;
  if (!hash) return;
  hoverHash = hash;
  tooltip.innerHTML = tooltipBase(hash);
  tooltip.hidden = false;
  positionTooltip(card);

  const details = await loadDetails(hash);
  if (hoverHash !== hash || tooltip.hidden) return;
  const locations = details.provenance?.sources || [];
  const collections = details.collections?.collections || [];
  let extra = '';
  if (locations.length) {
    extra += `<div class="context-section">${locations.slice(0, 4).map(item => `
      <div class="context-location"><b>${escapeHtml(item.deviceName || item.sourceName || 'Source')}</b><span>${escapeHtml(fullPath(item))}</span></div>`).join('')}${locations.length > 4 ? `<div class="context-summary">+${locations.length - 4} more location${locations.length - 4 === 1 ? '' : 's'}</div>` : ''}</div>`;
  }
  if (collections.length) extra += `<div class="context-section context-collections">Collections · ${escapeHtml(collections.map(item => item.name).join(', '))}</div>`;
  tooltip.innerHTML = tooltipBase(hash) + extra;
  positionTooltip(card);
}

function hideTooltip() {
  clearTimeout(hoverTimer);
  hoverTimer = 0;
  hoverHash = '';
  tooltip.hidden = true;
}

function visibleCards() {
  return [...files.querySelectorAll('[data-hash]')].filter(card => {
    const rect = card.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
}

function currentCard(cards) {
  const active = document.activeElement?.closest?.('[data-hash]');
  if (active && cards.includes(active)) return active;
  if (lastFocusedHash) {
    const remembered = cards.find(card => card.dataset.hash === lastFocusedHash);
    if (remembered) return remembered;
  }
  return cards.find(card => {
    const rect = card.getBoundingClientRect();
    return rect.bottom > 80 && rect.top < innerHeight;
  }) || cards[0];
}

function spatialCard(cards, current, direction) {
  if (!current) return cards[0];
  const rect = current.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  let best = null;
  let bestScore = Infinity;
  for (const card of cards) {
    if (card === current) continue;
    const next = card.getBoundingClientRect();
    const nx = next.left + next.width / 2;
    const ny = next.top + next.height / 2;
    const dx = nx - cx;
    const dy = ny - cy;
    if (direction === 'up' && dy >= -4) continue;
    if (direction === 'down' && dy <= 4) continue;
    const score = Math.abs(dy) * 3 + Math.abs(dx);
    if (score < bestScore) { best = card; bestScore = score; }
  }
  return best || current;
}

function focusCard(card) {
  if (!card) return;
  lastFocusedHash = card.dataset.hash;
  for (const item of files.querySelectorAll('.context-keyboard-focus')) item.classList.remove('context-keyboard-focus');
  card.classList.add('context-keyboard-focus');
  card.focus({ preventScroll: true });
  const rect = card.getBoundingClientRect();
  if (rect.top < 76 || rect.bottom > innerHeight - 24) card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  if (!matchMedia('(hover:none)').matches) showTooltip(card);
}

function typingTarget(target) {
  return Boolean(target?.closest?.('input,select,textarea,[contenteditable="true"]'));
}

toggle.addEventListener('click', () => {
  contextEnabled = !contextEnabled;
  localStorage.setItem(CONTEXT_KEY, contextEnabled ? '1' : '0');
  scheduleDecorate();
});

files.addEventListener('pointerover', event => {
  const card = event.target.closest('.file-card.media-card[data-hash]');
  if (!card || event.relatedTarget?.closest?.('[data-hash]') === card) return;
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => showTooltip(card), 180);
});

files.addEventListener('pointerout', event => {
  const card = event.target.closest('.file-card.media-card[data-hash]');
  if (!card || event.relatedTarget?.closest?.('[data-hash]') === card) return;
  hideTooltip();
});

files.addEventListener('focusin', event => {
  const card = event.target.closest('[data-hash]');
  if (!card) return;
  lastFocusedHash = card.dataset.hash;
  scheduleDecorate();
  if (card.matches('.file-card.media-card')) showTooltip(card);
});

files.addEventListener('focusout', event => {
  if (!event.relatedTarget?.closest?.('[data-hash]')) hideTooltip();
});

files.addEventListener('pointerdown', event => {
  const card = event.target.closest('[data-hash]');
  if (card) lastFocusedHash = card.dataset.hash;
});

document.addEventListener('keydown', event => {
  if (typingTarget(event.target)) return;

  if (!viewer.hidden) {
    if (event.code === 'Space' && !event.target.closest?.('video,button,a,input,select,textarea,summary')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      viewerClose.click();
      requestAnimationFrame(() => {
        const card = lastFocusedHash && files.querySelector(`[data-hash="${CSS.escape(lastFocusedHash)}"]`);
        if (card) focusCard(card);
      });
      return;
    }
    if (event.key.toLowerCase() === 'i' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      event.stopImmediatePropagation();
      viewerInfo?.click();
    }
    return;
  }

  if (!['grid', 'list'].includes(currentView())) return;
  const cards = visibleCards();
  if (!cards.length) return;
  const current = currentCard(cards);

  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    const index = Math.max(0, cards.indexOf(current));
    const step = event.key === 'ArrowLeft' ? -1 : 1;
    focusCard(cards[Math.max(0, Math.min(cards.length - 1, index + step))]);
    event.preventDefault();
    event.stopImmediatePropagation();
    return;
  }
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    focusCard(spatialCard(cards, current, event.key === 'ArrowUp' ? 'up' : 'down'));
    event.preventDefault();
    event.stopImmediatePropagation();
    return;
  }
  if (event.code === 'Space') {
    const card = currentCard(cards);
    if (!card) return;
    lastFocusedHash = card.dataset.hash;
    event.preventDefault();
    event.stopImmediatePropagation();
    hideTooltip();
    if (window.mochimonoOpenViewer) window.mochimonoOpenViewer(lastFocusedHash);
    else card.click();
  }
}, true);

new MutationObserver(scheduleDecorate).observe(files, { childList: true, subtree: true });
new MutationObserver(() => {
  syncToggle();
  hideTooltip();
  scheduleDecorate();
}).observe(views, { subtree: true, attributes: true, attributeFilter: ['class'] });
source.addEventListener('change', hideTooltip);
window.addEventListener('scroll', hideTooltip, { passive: true });
window.addEventListener('resize', hideTooltip, { passive: true });

refreshCache();
setTimeout(refreshCache, 1200);
setTimeout(refreshCache, 4000);
syncToggle();
scheduleDecorate();
