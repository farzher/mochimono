const files = document.querySelector('#files');
const views = document.querySelector('#views');
const source = document.querySelector('#source');
const viewer = document.querySelector('#viewer');
const viewerClose = document.querySelector('#viewer-close');
const viewerInfo = document.querySelector('#viewer-info-button');
const viewerOpen = document.querySelector('#viewer-open');
const mediaSizeControl = document.querySelector('#mediaSizeControl');
const CACHE_NAME = 'mochimono-catalog';
const CACHE_VERSION = 2;
const CONTEXT_KEY = 'mochimono-grid-context';

let contextEnabled = localStorage.getItem(CONTEXT_KEY) !== '0';
let fileInfo = new Map();
let sourceNames = new Map();
let cachePromise = null;
let decorateFrame = 0;
let hoverHash = '';
let lastFocusedHash = '';
let viewerWasOpen = !viewer.hidden;
const detailCache = new Map();

const style = document.createElement('style');
style.textContent = `
  .grid-context-toggle{width:34px;height:34px;padding:0;display:grid;place-items:center;background:#111013;color:#82797a;border-radius:10px}
  .grid-context-toggle:hover{background:var(--surface2);color:#ddd4d0}
  .grid-context-toggle.active{background:var(--surface3);color:#fff}
  .grid-context-toggle span{width:16px;height:16px;display:grid;place-items:center;border:1.5px solid currentColor;border-radius:50%;font:800 10px/1 system-ui}
  .file-card.media-card{position:relative}
  .file-context-badge{position:absolute;z-index:3;left:5px;right:5px;bottom:5px;min-width:0;padding:5px 6px;border-radius:6px;background:rgba(7,7,8,.72);backdrop-filter:blur(5px);pointer-events:none;text-shadow:0 1px 2px #000;opacity:.86;transition:opacity .1s}
  .file-context-badge strong,.file-context-badge span{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .file-context-badge strong{color:#f2ece8;font-size:9px;font-weight:720;line-height:1.2}
  .file-context-badge span{margin-top:2px;color:#aaa09d;font-size:8px;font-weight:620;line-height:1.2}
  .file-card.media-card:hover .file-context-badge,.file-card.media-card:focus .file-context-badge{opacity:1}
  .file-card.context-keyboard-focus,.file-row.context-keyboard-focus{box-shadow:0 0 0 3px rgba(239,160,154,.9)!important;outline:none}
  .file-context-tooltip{position:fixed;z-index:90;width:min(420px,calc(100vw - 24px));padding:11px 12px;border:1px solid #413a40;border-radius:11px;background:rgba(25,23,26,.98);box-shadow:0 14px 42px rgba(0,0,0,.5);color:#f3ece8;pointer-events:none;font-size:11px;line-height:1.35}
  .file-context-tooltip[hidden]{display:none}
  .file-context-tooltip>strong{display:block;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .context-meta{margin-top:3px;color:#aaa09d}
  .context-meta span+span:before{content:' · ';color:#665f60}
  .context-primary-path{margin-top:7px;padding:6px 7px;border-radius:7px;background:#171519;color:#cfc5c1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .context-section{margin-top:9px;padding-top:8px;border-top:1px solid #393438}
  .context-section-label{color:#807778;font-size:9px;font-weight:760;text-transform:uppercase;letter-spacing:.055em}
  .context-location{margin-top:6px;min-width:0}
  .context-location b{display:block;color:#d8ceca;font-size:10px}
  .context-location span{display:block;color:#948a87;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .context-collections{margin-top:5px;color:#cbb6d8}
  .context-empty{margin-top:5px;color:#756d6d}
  @media(hover:none){.file-context-tooltip{display:none!important}.file-context-badge strong{font-size:8px}.file-context-badge span{font-size:7px}}
`;
document.head.append(style);

const toggle = document.createElement('button');
toggle.type = 'button';
toggle.className = 'grid-context-toggle';
toggle.title = 'Show file details';
toggle.setAttribute('aria-label', 'Show file details');
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
  const parts = normalizePath(value).split('/').filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join('/') : '';
}

function pathTail(value, count = 2) {
  return normalizePath(value).split('/').filter(Boolean).slice(-count).join(' / ');
}

function fileSources(file) {
  return [...new Set(importIds(file).map(id => sourceNames.get(id)).filter(Boolean))];
}

function briefContext(file) {
  if (!file) return '';
  const names = fileSources(file);
  const folder = pathTail(dirname(file.originalPath), 2);
  if (names.length === 1 && folder) return `${names[0]} · ${folder}`;
  if (folder) return folder;
  if (names.length === 1) return names[0];
  if (names.length > 1) return `${names.length} sources`;
  return '';
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes || 0);
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return `${value < 10 && unit ? value.toFixed(2) : value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function formatDate(file) {
  const value = file?.fileDate || file?.dateMs || file?.createdAt;
  const date = new Date(value || 0);
  return Number.isNaN(date.getTime()) || !date.getTime()
    ? ''
    : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
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

function cardName(card, file) {
  return file?.filename || card?.getAttribute('title') || card?.querySelector('.file-main strong')?.textContent || 'File';
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
    badge.innerHTML = `<strong>${escapeHtml(cardName(card, file))}</strong><span>${escapeHtml(briefContext(file) || 'No folder recorded')}</span>`;
  }
  for (const card of files.querySelectorAll('[data-hash]')) {
    card.classList.toggle('context-keyboard-focus', card.dataset.hash === lastFocusedHash);
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

function currentViewerHash() {
  return viewerOpen?.getAttribute('href')?.match(/\/api\/objects\/([a-f0-9]{64})/)?.[1] || '';
}

function tooltipBase(hash) {
  const file = fileInfo.get(hash);
  const card = files.querySelector(`[data-hash="${CSS.escape(hash)}"]`);
  const meta = [];
  const date = formatDate(file);
  if (date) meta.push(date);
  if (file?.size) meta.push(formatBytes(file.size));
  if (file?.width && file?.height) meta.push(`${file.width}×${file.height}`);
  if (file?.mime) meta.push(file.mime);
  const primary = normalizePath(file?.originalPath);
  return `<strong>${escapeHtml(cardName(card, file))}</strong>
    ${meta.length ? `<div class="context-meta">${meta.map(item => `<span>${escapeHtml(item)}</span>`).join('')}</div>` : ''}
    ${primary ? `<div class="context-primary-path" title="${escapeHtml(primary)}">${escapeHtml(primary)}</div>` : ''}`;
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
  if (!card || tooltip.hidden) return;
  const rect = card.getBoundingClientRect();
  const width = Math.min(420, innerWidth - 24);
  const rightFits = rect.right + width + 10 <= innerWidth;
  const left = rightFits ? rect.right + 8 : Math.max(12, Math.min(innerWidth - width - 12, rect.left));
  const top = Math.max(12, Math.min(innerHeight - tooltip.offsetHeight - 12, rect.top));
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

async function showTooltip(card) {
  if (!card || viewer.hidden === false || !['grid', 'list'].includes(currentView())) return;
  const hash = card.dataset.hash;
  if (!hash) return;
  hoverHash = hash;
  tooltip.innerHTML = tooltipBase(hash);
  tooltip.hidden = false;
  positionTooltip(card);

  const details = await loadDetails(hash);
  if (hoverHash !== hash || tooltip.hidden) return;
  const locations = details.provenance?.sources || [];
  const collections = details.collections?.collections || [];
  let extra = '<div class="context-section"><div class="context-section-label">Locations</div>';
  if (locations.length) {
    extra += locations.slice(0, 6).map(item => `
      <div class="context-location"><b>${escapeHtml(item.deviceName || item.sourceName || 'Source')}</b><span title="${escapeHtml(fullPath(item))}">${escapeHtml(fullPath(item))}</span></div>`).join('');
    if (locations.length > 6) extra += `<div class="context-empty">+${locations.length - 6} more</div>`;
  } else extra += '<div class="context-empty">No additional recorded locations.</div>';
  extra += '</div>';
  if (collections.length) {
    extra += `<div class="context-section"><div class="context-section-label">Collections</div><div class="context-collections">${escapeHtml(collections.map(item => item.name).join(' · '))}</div></div>`;
  }
  tooltip.innerHTML = tooltipBase(hash) + extra;
  positionTooltip(card);
}

function hideTooltip() {
  hoverHash = '';
  tooltip.hidden = true;
}

function renderedCards() {
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

function verticalCard(cards, current, direction) {
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
    if (direction < 0 && dy >= -3) continue;
    if (direction > 0 && dy <= 3) continue;
    const score = Math.abs(dy) * 3 + Math.abs(dx);
    if (score < bestScore) { best = card; bestScore = score; }
  }
  return best || current;
}

function focusCard(card, showInfo = true) {
  if (!card) return;
  lastFocusedHash = card.dataset.hash;
  for (const item of files.querySelectorAll('.context-keyboard-focus')) item.classList.remove('context-keyboard-focus');
  card.classList.add('context-keyboard-focus');
  card.focus({ preventScroll: true });
  card.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
  if (showInfo && !matchMedia('(hover:none)').matches) requestAnimationFrame(() => showTooltip(card));
}

function typingTarget(target) {
  return Boolean(target?.closest?.('input,select,textarea,[contenteditable="true"]'));
}

function viewerOwnsSpace() {
  const active = document.activeElement;
  return Boolean(active && viewer.contains(active) && active.closest('video,input,select,textarea,summary,button,a'));
}

toggle.addEventListener('click', () => {
  contextEnabled = !contextEnabled;
  localStorage.setItem(CONTEXT_KEY, contextEnabled ? '1' : '0');
  scheduleDecorate();
});

files.addEventListener('pointerover', event => {
  const card = event.target.closest('[data-hash]');
  if (!card || event.relatedTarget?.closest?.('[data-hash]') === card) return;
  showTooltip(card);
});

files.addEventListener('pointerout', event => {
  const card = event.target.closest('[data-hash]');
  if (!card || event.relatedTarget?.closest?.('[data-hash]') === card) return;
  if (document.activeElement !== card) hideTooltip();
});

files.addEventListener('focusin', event => {
  const card = event.target.closest('[data-hash]');
  if (!card) return;
  lastFocusedHash = card.dataset.hash;
  scheduleDecorate();
  requestAnimationFrame(() => showTooltip(card));
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
    if (event.code === 'Space' && !viewerOwnsSpace()) {
      lastFocusedHash = currentViewerHash() || lastFocusedHash;
      event.preventDefault();
      event.stopImmediatePropagation();
      viewerClose.click();
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
  const cards = renderedCards();
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
    focusCard(verticalCard(cards, current, event.key === 'ArrowUp' ? -1 : 1));
    event.preventDefault();
    event.stopImmediatePropagation();
    return;
  }
  if (event.code === 'Space') {
    if (!current) return;
    lastFocusedHash = current.dataset.hash;
    event.preventDefault();
    event.stopImmediatePropagation();
    hideTooltip();
    if (window.mochimonoOpenViewer) window.mochimonoOpenViewer(lastFocusedHash);
    else current.click();
  }
}, true);

new MutationObserver(scheduleDecorate).observe(files, { childList: true, subtree: true });
new MutationObserver(() => {
  syncToggle();
  hideTooltip();
  scheduleDecorate();
}).observe(views, { subtree: true, attributes: true, attributeFilter: ['class'] });
new MutationObserver(() => {
  const open = !viewer.hidden;
  if (!open && viewerWasOpen) {
    lastFocusedHash = currentViewerHash() || lastFocusedHash;
    requestAnimationFrame(() => {
      const card = lastFocusedHash && files.querySelector(`[data-hash="${CSS.escape(lastFocusedHash)}"]`);
      if (card) focusCard(card);
    });
  }
  viewerWasOpen = open;
}).observe(viewer, { attributes: true, attributeFilter: ['hidden'] });

source.addEventListener('change', hideTooltip);
window.addEventListener('scroll', () => {
  if (tooltip.hidden) return;
  const card = hoverHash && files.querySelector(`[data-hash="${CSS.escape(hoverHash)}"]`);
  if (card) positionTooltip(card);
  else hideTooltip();
}, { passive: true });
window.addEventListener('resize', hideTooltip, { passive: true });

refreshCache();
setTimeout(refreshCache, 700);
setTimeout(refreshCache, 2200);
syncToggle();
scheduleDecorate();
