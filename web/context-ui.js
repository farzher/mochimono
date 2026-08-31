const files = document.querySelector('#files');
const views = document.querySelector('#views');
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
let lastFocusedHash = '';
let pointerHash = '';

const style = document.createElement('style');
style.textContent = `
  .grid-context-toggle{width:34px;height:34px;padding:0;display:grid;place-items:center;background:#111013;color:#82797a;border-radius:10px}
  .grid-context-toggle:hover{background:var(--surface2);color:#ddd4d0}
  .grid-context-toggle.active{background:var(--surface3);color:#fff}
  .grid-context-toggle span{width:16px;height:16px;display:grid;place-items:center;border:1.5px solid currentColor;border-radius:50%;font:800 10px/1 system-ui}
  .file-card.media-card{position:relative}
  .file-context-badge{position:absolute;z-index:3;left:0;right:0;bottom:0;min-width:0;padding:28px 8px 7px;background:linear-gradient(to bottom,transparent 0,rgba(5,5,6,.3) 35%,rgba(5,5,6,.9) 100%);pointer-events:none;text-shadow:0 1px 3px #000;opacity:0;transform:translateY(3px);transition:opacity .1s ease,transform .1s ease}
  .file-context-badge strong,.file-context-badge span{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .file-context-badge strong{color:#fff;font-size:10px;font-weight:720;line-height:1.2}
  .file-context-badge span{margin-top:2px;color:#c7bfbc;font-size:8px;font-weight:600;line-height:1.2}
  .file-card.context-pointer-hover .file-context-badge,
  .file-card.context-keyboard-focus .file-context-badge,
  .file-card:focus-visible .file-context-badge{opacity:1;transform:none}
  .files.has-context-hover .file-card.context-keyboard-focus:not(.context-pointer-hover) .file-context-badge{opacity:0;transform:translateY(3px)}
  .file-card.context-keyboard-focus,.file-row.context-keyboard-focus{box-shadow:0 0 0 3px rgba(239,160,154,.9)!important;outline:none}
  @media(max-width:700px){.file-context-badge{padding:24px 7px 6px}.file-context-badge strong{font-size:9px}.file-context-badge span{font-size:7px}}
`;
document.head.append(style);

const toggle = document.createElement('button');
toggle.type = 'button';
toggle.className = 'grid-context-toggle';
toggle.title = 'Show file context';
toggle.setAttribute('aria-label', 'Show file context');
toggle.innerHTML = '<span aria-hidden="true">i</span>';
mediaSizeControl.after(toggle);

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
  return `${value < 10 && unit ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function shortDate(value) {
  const date = new Date(value || 0);
  if (Number.isNaN(date.getTime()) || !date.getTime()) return '';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

function overlayContext(file) {
  const parts = [];
  const context = briefContext(file);
  const date = shortDate(file?.fileDate || file?.createdAt);
  if (context) parts.push(context);
  if (date) parts.push(date);
  if (file?.size) parts.push(formatBytes(file.size));
  return parts.join(' · ') || 'No folder recorded';
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
    badge.innerHTML = `<strong>${escapeHtml(cardName(card, file))}</strong><span>${escapeHtml(overlayContext(file))}</span>`;
  }
  for (const card of files.querySelectorAll('[data-hash]')) {
    card.classList.toggle('context-keyboard-focus', card.dataset.hash === lastFocusedHash);
    card.classList.toggle('context-pointer-hover', card.dataset.hash === pointerHash);
  }
  files.classList.toggle('has-context-hover', Boolean(pointerHash));
}

function scheduleDecorate() {
  if (!decorateFrame) decorateFrame = requestAnimationFrame(decorate);
}

function currentViewerHash() {
  return viewerOpen?.getAttribute('href')?.match(/\/api\/objects\/([a-f0-9]{64})/)?.[1] || '';
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

function viewerVerticalCard(direction) {
  const hash = currentViewerHash();
  if (!hash) return null;
  const cards = renderedCards();
  const current = cards.find(card => card.dataset.hash === hash);
  if (!current) return null;
  const next = verticalCard(cards, current, direction);
  return next !== current ? next : null;
}

function focusCard(card) {
  if (!card) return;
  lastFocusedHash = card.dataset.hash;
  pointerHash = '';
  card.focus({ preventScroll: true });
  card.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
  scheduleDecorate();
}

function typingTarget(target) {
  return Boolean(target?.closest?.('input,select,textarea,[contenteditable="true"]'));
}

function viewerControlFocused() {
  const active = document.activeElement;
  return Boolean(active && viewer.contains(active) && active.closest('video,input,select,textarea,summary,button,a'));
}

function openCurrent(card) {
  if (!card) return;
  lastFocusedHash = card.dataset.hash;
  pointerHash = '';
  scheduleDecorate();
  if (window.mochimonoOpenViewer) window.mochimonoOpenViewer(lastFocusedHash);
  else card.click();
}

toggle.addEventListener('click', () => {
  contextEnabled = !contextEnabled;
  localStorage.setItem(CONTEXT_KEY, contextEnabled ? '1' : '0');
  scheduleDecorate();
});

files.addEventListener('pointermove', event => {
  if (event.pointerType === 'touch') return;
  const card = event.target.closest('.file-card.media-card[data-hash]');
  const hash = card?.dataset.hash || '';
  if (hash === pointerHash) return;
  pointerHash = hash;
  scheduleDecorate();
});

files.addEventListener('pointerleave', () => {
  if (!pointerHash) return;
  pointerHash = '';
  scheduleDecorate();
});

files.addEventListener('focusin', event => {
  const card = event.target.closest('[data-hash]');
  if (!card) return;
  lastFocusedHash = card.dataset.hash;
  scheduleDecorate();
});

files.addEventListener('pointerdown', event => {
  const card = event.target.closest('[data-hash]');
  if (!card) return;
  lastFocusedHash = card.dataset.hash;
  scheduleDecorate();
});

document.addEventListener('keydown', event => {
  if (typingTarget(event.target)) return;

  if (!viewer.hidden) {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      event.stopImmediatePropagation();
      const target = viewerVerticalCard(event.key === 'ArrowUp' ? -1 : 1);
      if (target && window.mochimonoOpenViewer) {
        lastFocusedHash = target.dataset.hash;
        window.mochimonoOpenViewer(lastFocusedHash);
      }
      return;
    }
    if ((event.code === 'Space' || event.key === 'Enter') && !viewerControlFocused()) {
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
    event.preventDefault();
    event.stopImmediatePropagation();
    openCurrent(current);
    return;
  }
  if (event.key === 'Enter') {
    const active = document.activeElement?.closest?.('[data-hash]');
    if (!active) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openCurrent(active);
  }
}, true);

new MutationObserver(scheduleDecorate).observe(files, { childList: true, subtree: true });
new MutationObserver(() => {
  pointerHash = '';
  syncToggle();
  scheduleDecorate();
}).observe(views, { subtree: true, attributes: true, attributeFilter: ['class'] });

window.addEventListener('mochimono-viewer-return', event => {
  const hash = String(event.detail?.hash || '');
  if (!hash) return;
  lastFocusedHash = hash;
  pointerHash = '';
  const card = files.querySelector(`[data-hash="${CSS.escape(hash)}"]`);
  card?.focus({ preventScroll: true });
  scheduleDecorate();
});

refreshCache();
setTimeout(refreshCache, 700);
setTimeout(refreshCache, 2200);
syncToggle();
scheduleDecorate();
