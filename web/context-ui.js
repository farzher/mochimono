import './collection-delete.js';

const files = document.querySelector('#files');
const views = document.querySelector('#views');
const viewer = document.querySelector('#viewer');
const viewerClose = document.querySelector('#viewer-close');
const viewerInfo = document.querySelector('#viewer-info-button');
const viewerOpen = document.querySelector('#viewer-open');
const search = document.querySelector('#search');

let decorateFrame = 0;
let fullDecorate = true;
let focusedHash = '';
let pointerHash = '';
let detailGeneration = 0;
let paging = false;
let queuedKey = '';
const pendingCards = new Set();
const detailTimers = new Map();
const detailsCache = new Map();

const style = document.createElement('style');
style.textContent = `
  .files.grid .file-card{position:relative}
  .files.grid .file-card:not(.media-card){flex:0 0 auto;width:calc(var(--media-size) * 1.333);height:var(--media-size);background:#100f11;border-radius:3px}
  .files.grid .file-card:not(.media-card) .thumb{width:100%;height:100%;display:grid;place-items:center}
  .files.grid .file-card:not(.media-card) .card-copy{display:none}
  .file-context-badge{position:absolute;z-index:3;left:0;right:0;bottom:0;min-width:0;padding:28px 8px 7px;display:flex;align-items:baseline;gap:7px;background:linear-gradient(to bottom,transparent 0,rgba(5,5,6,.3) 35%,rgba(5,5,6,.9) 100%);color:#fff;font-size:10px;font-weight:720;line-height:1.2;pointer-events:none;text-shadow:0 1px 3px #000;opacity:0;transform:translateY(3px);transition:opacity .1s ease,transform .1s ease}
  .file-context-name,.file-context-match{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .file-context-name{flex:1 1 auto}.file-context-badge.has-match .file-context-name{flex:0 1 44%;max-width:44%}
  .file-context-match{flex:1 1 auto;color:#c9c0bd;font-weight:600}.file-context-match mark{padding:0;background:transparent;color:#ff6f67;font-weight:800}
  .file-card.context-pointer-hover .file-context-badge,.file-card.context-keyboard-focus .file-context-badge,.file-card:focus-visible .file-context-badge{opacity:1;transform:none}
  .file-card.context-keyboard-focus,.file-row.context-keyboard-focus{box-shadow:0 0 0 3px rgba(239,160,154,.9)!important;outline:none}
  @media(max-width:700px){.file-context-badge{padding:24px 7px 6px;font-size:9px}.file-context-badge.has-match .file-context-name{max-width:38%}}
`;
document.head.append(style);

const normalize = text => window.mochimonoSearch?.normalize?.(text) || String(text || '').toLowerCase();
const currentView = () => views.querySelector('[data-view].active')?.dataset.view || 'grid';
const currentSearch = () => String(window.mochimonoSearch?.raw?.() ?? search?.value ?? '').trim();
const viewerHash = () => viewerOpen?.getAttribute('href')?.match(/\/api\/objects\/([a-f0-9]{64})/)?.[1] || '';
const typingTarget = target => Boolean(target?.closest?.('input,select,textarea,[contenteditable="true"]'));
const cardForHash = hash => hash ? files.querySelector(`[data-hash="${CSS.escape(hash)}"]`) : null;

function queryHint(raw) {
  const field = raw.match(/\b(name|path|source|location|type|ext|year):/i)?.[1]?.toLowerCase() || '';
  const terms = normalize(raw.replace(/\b(?:name|path|source|location|type|ext|year):/gi, ' ').replace(/["']/g, ' ')).split(' ').filter(Boolean);
  return { field, terms };
}

function filenameTerms(raw, filename) {
  const field = raw.match(/\b(name|path|source|location|type|ext|year):/i)?.[1]?.toLowerCase() || '';
  if (field && field !== 'name') return [];
  return normalize(raw.replace(/\bname:/gi, ' ').replace(/["']/g, ' ')).split(' ').filter(term => term && normalize(filename).includes(term));
}

function sourcePath(source) {
  const root = String(source.rootPath || '').replace(/[\\/]+$/, '');
  const relative = String(source.path || '').replace(/^[\\/]+/, '');
  if (!root) return relative;
  if (!relative) return root;
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  return `${root}${separator}${relative.replace(/[\\/]+/g, separator)}`;
}

function searchReason(details, raw, filename) {
  const { field, terms } = queryHint(raw);
  if (!terms.length || field === 'name' || field === 'location' || (!field && terms.every(term => normalize(filename).includes(term)))) return null;
  const sources = details?.sources || [];
  const ext = filename.match(/\.([^.]+)$/)?.[1] || '';
  const type = String(details?.object?.mime || '').split('/')[0] || 'file';
  const date = new Date(details?.date?.fileDate || details?.object?.createdAt || 0);
  const groups = {
    path: sources.flatMap(item => [sourcePath(item), item.path, item.rootPath]),
    source: sources.flatMap(item => [item.sourceName, item.deviceName]),
    type: [type], ext: [ext ? `.${ext}` : ''], year: [Number.isNaN(date.getTime()) ? '' : String(date.getFullYear())]
  };
  const candidates = (field ? [[field, groups[field] || []]] : Object.entries(groups))
    .flatMap(([label, values]) => values.map(value => ({ label, value: String(value || '').trim() }))).filter(item => item.value);
  const match = candidates.find(item => terms.every(term => normalize(item.value).includes(term))) || candidates.find(item => terms.some(term => normalize(item.value).includes(term)));
  return match ? { text: `${match.label}: ${match.value}`, terms: terms.filter(term => normalize(match.value).includes(term)) } : null;
}

function highlighted(element, text, terms) {
  element.replaceChildren();
  const escaped = [...new Set(terms)].filter(Boolean).sort((a, b) => b.length - a.length).map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!escaped.length) return void (element.textContent = text);
  const regex = new RegExp(`(${escaped.join('|')})`, 'ig');
  let offset = 0;
  for (const match of String(text).matchAll(regex)) {
    if (match.index > offset) element.append(document.createTextNode(text.slice(offset, match.index)));
    const mark = document.createElement('mark');
    mark.textContent = match[0];
    element.append(mark);
    offset = match.index + match[0].length;
  }
  if (offset < text.length) element.append(document.createTextNode(text.slice(offset)));
}

function renderReason(badge, reason) {
  if (!badge) return;
  const target = badge.querySelector('.file-context-match');
  const key = reason ? `${reason.text}\0${reason.terms.join('|')}` : '';
  if (badge.dataset.reasonKey === key) return;
  badge.dataset.reasonKey = key;
  badge.classList.toggle('has-match', Boolean(reason));
  if (reason) highlighted(target, reason.text, reason.terms);
  else target.replaceChildren();
}

function loadReason(card, badge) {
  const raw = currentSearch();
  if (!raw) return renderReason(badge, null);
  const hash = card.dataset.hash;
  const filename = card.dataset.filename || 'File';
  if (detailsCache.has(hash)) return renderReason(badge, searchReason(detailsCache.get(hash), raw, filename));
  renderReason(badge, null);
  clearTimeout(detailTimers.get(hash));
  const generation = detailGeneration;
  detailTimers.set(hash, setTimeout(async () => {
    detailTimers.delete(hash);
    try {
      const response = await fetch(`/api/files/${hash}/details`);
      if (!response.ok) return;
      const details = await response.json();
      detailsCache.set(hash, details);
      if (generation !== detailGeneration || currentSearch() !== raw || (hash !== pointerHash && hash !== focusedHash)) return;
      const current = cardForHash(hash)?.querySelector('.file-context-badge');
      if (current) renderReason(current, searchReason(details, raw, filename));
    } catch {}
  }, 90));
}

function ensureBadge(card, raw) {
  let badge = card.querySelector('.file-context-badge');
  if (currentView() !== 'grid') {
    badge?.remove();
    return null;
  }
  const filename = card.dataset.filename || card.getAttribute('title') || 'File';
  card.dataset.filename = filename;
  card.removeAttribute('title');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'file-context-badge';
    badge.innerHTML = '<span class="file-context-name"></span><span class="file-context-match"></span>';
    card.append(badge);
  }
  const name = badge.querySelector('.file-context-name');
  const terms = filenameTerms(raw, filename);
  const nameKey = `${filename}\0${terms.join('|')}`;
  if (name.dataset.highlightKey !== nameKey) {
    name.dataset.highlightKey = nameKey;
    highlighted(name, filename, terms);
  }
  return badge;
}

function syncCardState(card, raw = currentSearch()) {
  if (!card?.isConnected) return;
  const hash = card.dataset.hash || '';
  card.classList.toggle('context-keyboard-focus', hash === focusedHash);
  card.classList.toggle('context-pointer-hover', hash === pointerHash);
  if (!card.classList.contains('file-card')) return;
  const badge = ensureBadge(card, raw);
  if (!badge) return;
  if (hash === focusedHash || hash === pointerHash) loadReason(card, badge);
  else renderReason(badge, null);
}

function decorate() {
  decorateFrame = 0;
  const raw = currentSearch();
  const cards = fullDecorate
    ? [...files.querySelectorAll('[data-hash]')]
    : [...pendingCards];
  fullDecorate = false;
  pendingCards.clear();
  for (const card of cards) syncCardState(card, raw);
}

function scheduleDecorate(cards = null) {
  if (cards == null) fullDecorate = true;
  else for (const card of cards) if (card?.matches?.('[data-hash]')) pendingCards.add(card);
  if (!decorateFrame) decorateFrame = requestAnimationFrame(decorate);
}

function refreshHashes(...hashes) {
  const raw = currentSearch();
  for (const hash of new Set(hashes.filter(Boolean))) {
    const card = cardForHash(hash);
    if (card) syncCardState(card, raw);
  }
}

function setPointerHash(next) {
  next = String(next || '');
  if (next === pointerHash) return;
  const previous = pointerHash;
  pointerHash = next;
  detailGeneration++;
  refreshHashes(previous, next);
}

function setFocusedHash(next) {
  next = String(next || '');
  if (next === focusedHash) return;
  const previous = focusedHash;
  focusedHash = next;
  detailGeneration++;
  refreshHashes(previous, next);
}

function cards() {
  return [...files.querySelectorAll('[data-hash]')].filter(card => {
    const rect = card.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
}

function currentCard(items) {
  const active = document.activeElement?.closest?.('[data-hash]');
  if (active && items.includes(active)) return active;
  const remembered = focusedHash && items.find(card => card.dataset.hash === focusedHash);
  return remembered || items.find(card => {
    const rect = card.getBoundingClientRect();
    return rect.bottom > 80 && rect.top < innerHeight;
  }) || items[0];
}

function verticalCard(items, current, direction) {
  if (!current) return null;
  const rect = current.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  let best = null;
  let score = Infinity;
  for (const card of items) {
    if (card === current) continue;
    const next = card.getBoundingClientRect();
    const dx = next.left + next.width / 2 - cx;
    const dy = next.top + next.height / 2 - cy;
    if ((direction < 0 && dy >= -3) || (direction > 0 && dy <= 3)) continue;
    const candidate = Math.abs(dy) * 3 + Math.abs(dx);
    if (candidate < score) { best = card; score = candidate; }
  }
  return best;
}

function focusCard(card) {
  if (!card) return false;
  setFocusedHash(card.dataset.hash);
  if (card.tabIndex < 0) card.tabIndex = 0;
  card.focus({ preventScroll: true });
  card.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
  return true;
}

function openCard(card) {
  if (!card) return false;
  setFocusedHash(card.dataset.hash);
  window.mochimonoOpenViewer?.(focusedHash) || card.click();
  return true;
}

const afterLayout = callback => requestAnimationFrame(() => requestAnimationFrame(callback));

function extend(direction, callback) {
  if (!window.mochimonoLibrary?.extend?.(direction)) return false;
  paging = true;
  afterLayout(() => {
    try { callback(); }
    finally {
      paging = false;
      const key = queuedKey;
      queuedKey = '';
      if (key) navigate(key);
    }
  });
  return true;
}

function navigateGrid(key) {
  const items = cards();
  const current = currentCard(items);
  if (!current) return false;
  const hash = current.dataset.hash;
  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    const direction = key === 'ArrowLeft' ? -1 : 1;
    const direct = items[items.indexOf(current) + direction];
    if (direct) return focusCard(direct);
    return extend(direction, () => {
      const next = cards();
      const start = next.find(card => card.dataset.hash === hash);
      focusCard(start ? next[next.indexOf(start) + direction] : next[direction > 0 ? 0 : next.length - 1]);
    });
  }
  if (key === 'ArrowUp' || key === 'ArrowDown') {
    const direction = key === 'ArrowUp' ? -1 : 1;
    const direct = verticalCard(items, current, direction);
    if (direct) return focusCard(direct);
    return extend(direction, () => {
      const next = cards();
      const start = next.find(card => card.dataset.hash === hash);
      focusCard(verticalCard(next, start, direction));
    });
  }
  return false;
}

function navigateViewer(key) {
  if (key !== 'ArrowUp' && key !== 'ArrowDown') return false;
  const direction = key === 'ArrowUp' ? -1 : 1;
  const hash = viewerHash();
  if (!hash) return false;
  const items = cards();
  const current = items.find(card => card.dataset.hash === hash);
  const direct = verticalCard(items, current, direction);
  if (direct) {
    setFocusedHash(direct.dataset.hash);
    window.mochimonoOpenViewer?.(focusedHash);
    return true;
  }
  return extend(direction, () => {
    const next = cards();
    const start = next.find(card => card.dataset.hash === hash);
    const target = verticalCard(next, start, direction);
    if (target) {
      setFocusedHash(target.dataset.hash);
      window.mochimonoOpenViewer?.(focusedHash);
    }
  });
}

function navigate(key) {
  if (paging) { queuedKey = key; return true; }
  return viewer.hidden ? navigateGrid(key) : navigateViewer(key);
}

files.addEventListener('pointermove', event => {
  if (event.pointerType === 'touch') return;
  setPointerHash(event.target.closest('.file-card[data-hash]')?.dataset.hash || '');
});
files.addEventListener('pointerleave', () => setPointerHash(''));
files.addEventListener('focusin', event => {
  const hash = event.target.closest('[data-hash]')?.dataset.hash;
  if (hash) setFocusedHash(hash);
});
files.addEventListener('pointerdown', event => {
  const card = event.target.closest('[data-hash]');
  if (!card) return;
  setFocusedHash(card.dataset.hash);
  if (event.pointerType !== 'touch') card.focus({ preventScroll: true });
});
search?.addEventListener('input', () => {
  detailGeneration++;
  for (const timer of detailTimers.values()) clearTimeout(timer);
  detailTimers.clear();
  scheduleDecorate();
});

document.addEventListener('keydown', event => {
  const viewerOpenNow = !viewer.hidden;
  if (typingTarget(event.target) && !viewerOpenNow) return;
  if (paging && event.key.startsWith('Arrow')) {
    queuedKey = event.key;
    event.preventDefault();
    event.stopImmediatePropagation();
    return;
  }
  if (viewerOpenNow) {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      if (navigate(event.key)) { event.preventDefault(); event.stopImmediatePropagation(); }
      return;
    }
    if ((event.code === 'Space' || event.key === 'Enter') && !document.activeElement?.closest?.('#viewer video,#viewer input,#viewer select,#viewer textarea,#viewer summary,#viewer button,#viewer a')) {
      setFocusedHash(viewerHash() || focusedHash);
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
  if (!['grid','list'].includes(currentView())) return;
  if (event.key.startsWith('Arrow') && navigate(event.key)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    return;
  }
  if (event.code === 'Space' || event.key === 'Enter') {
    const current = currentCard(cards());
    if (openCard(current)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }
}, true);

new MutationObserver(records => {
  const added = [];
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (!(node instanceof Element)) continue;
      if (node.matches('.file-card[data-hash]')) added.push(node);
      node.querySelectorAll?.('.file-card[data-hash]').forEach(card => added.push(card));
    }
  }
  if (added.length) scheduleDecorate(added);
}).observe(files, { childList: true, subtree: true });

views.addEventListener('click', () => {
  setPointerHash('');
  detailGeneration++;
  scheduleDecorate();
});
window.addEventListener('mochimono-viewer-return', event => {
  const hash = String(event.detail?.hash || '');
  if (!hash) return;
  setPointerHash('');
  setFocusedHash(hash);
  const card = cardForHash(hash);
  if (card) focusCard(card);
  else scheduleDecorate();
});
scheduleDecorate();
