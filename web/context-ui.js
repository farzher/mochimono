import './collection-delete.js';

const files = document.querySelector('#files');
const views = document.querySelector('#views');
const viewer = document.querySelector('#viewer');
const viewerClose = document.querySelector('#viewer-close');
const viewerInfo = document.querySelector('#viewer-info-button');
const viewerOpen = document.querySelector('#viewer-open');
const viewerPrev = document.querySelector('#viewer-prev');
const viewerNext = document.querySelector('#viewer-next');
const search = document.querySelector('#search');

let decorateFrame = 0;
let lastFocusedHash = '';
let pointerHash = '';
let reasonTimer = 0;
let reasonGeneration = 0;
let viewerVerticalPending = false;
let queuedViewerVertical = 0;
const detailsCache = new Map();

const style = document.createElement('style');
style.textContent = `
  .files.grid .file-card{position:relative}
  .files.grid .file-card:not(.media-card){flex:0 0 auto;width:calc(var(--media-size) * 1.333);height:var(--media-size);background:#100f11;border-radius:3px}
  .files.grid .file-card:not(.media-card) .thumb{width:100%;height:100%;display:grid;place-items:center}
  .files.grid .file-card:not(.media-card) .card-copy{display:none}
  .file-context-badge{position:absolute;z-index:3;left:0;right:0;bottom:0;min-width:0;padding:28px 8px 7px;display:flex;align-items:baseline;gap:7px;background:linear-gradient(to bottom,transparent 0,rgba(5,5,6,.3) 35%,rgba(5,5,6,.9) 100%);color:#fff;font-size:10px;font-weight:720;line-height:1.2;pointer-events:none;text-shadow:0 1px 3px #000;opacity:0;transform:translateY(3px);transition:opacity .1s ease,transform .1s ease}
  .file-context-name,.file-context-match{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .file-context-name{flex:1 1 auto}
  .file-context-badge.has-match .file-context-name{flex:0 1 44%;max-width:44%}
  .file-context-match{flex:1 1 auto;color:#c9c0bd;font-weight:600}
  .file-context-match mark{padding:0;background:transparent;color:#ff6f67;font-weight:800}
  .file-card.context-pointer-hover .file-context-badge,
  .file-card.context-keyboard-focus .file-context-badge,
  .file-card:focus-visible .file-context-badge{opacity:1;transform:none}
  .files.has-context-hover .file-card.context-keyboard-focus:not(.context-pointer-hover) .file-context-badge{opacity:0;transform:translateY(3px)}
  .file-card.context-keyboard-focus,.file-row.context-keyboard-focus{box-shadow:0 0 0 3px rgba(239,160,154,.9)!important;outline:none}
  @media(max-width:700px){.file-context-badge{padding:24px 7px 6px;font-size:9px}.file-context-badge.has-match .file-context-name{max-width:38%}}
`;
document.head.append(style);

function currentView() {
  return views.querySelector('[data-view].active')?.dataset.view || 'grid';
}

function normalizeText(text) {
  return String(text || '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function queryHint(raw) {
  const field = raw.match(/\b(name|path|source|type|ext|year):/i)?.[1]?.toLowerCase() || '';
  let terms = normalizeText(raw.replace(/\b(?:name|path|source|type|ext|year):/gi, ' ').replace(/["']/g, ' ')).split(' ').filter(Boolean);
  if (field === 'type' && terms.length === 1) {
    const aliases = { photo: 'image', photos: 'image', picture: 'image', pictures: 'image', images: 'image', videos: 'video', movies: 'video', music: 'audio', document: 'application', documents: 'application', docs: 'application' };
    terms = [aliases[terms[0]] || terms[0]];
  }
  return { field, terms };
}

function sourcePath(source) {
  const root = String(source.rootPath || '').replace(/[\\/]+$/, '');
  const relative = String(source.path || '').replace(/^[\\/]+/, '');
  if (!root) return relative;
  if (!relative) return root;
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  return `${root}${separator}${relative.replace(/[\\/]+/g, separator)}`;
}

function fileType(details, filename) {
  const mime = String(details?.object?.mime || '');
  const base = mime.split('/')[0];
  if (base && base !== 'application') return base;
  const ext = String(filename || '').toLowerCase().match(/\.([^.]+)$/)?.[1] || '';
  if (['jpg','jpeg','png','gif','webp','heic','heif','avif','bmp','tif','tiff'].includes(ext)) return 'image';
  if (['mp4','m4v','mov','mkv','webm','avi','mpg','mpeg','m2v','mts','m2ts','3gp'].includes(ext)) return 'video';
  if (['mp3','m4a','aac','wav','flac','ogg','opus'].includes(ext)) return 'audio';
  return base || 'file';
}

function searchReason(details, raw, filename) {
  const { field, terms } = queryHint(raw);
  if (!terms.length || field === 'name') return null;
  if (!field && terms.every(term => normalizeText(filename).includes(term))) return null;

  const sources = Array.isArray(details?.sources) ? details.sources : [];
  const paths = sources.flatMap(source => [sourcePath(source), source.path, source.rootPath]);
  const sourceNames = sources.flatMap(source => [source.sourceName, source.deviceName]);
  const ext = String(filename || '').match(/\.([^.]+)$/)?.[1] || '';
  const date = new Date(details?.date?.fileDate || details?.object?.createdAt || 0);
  const year = Number.isNaN(date.getTime()) ? '' : String(date.getFullYear());
  const groups = {
    path: paths,
    source: sourceNames,
    type: [fileType(details, filename)],
    ext: [ext ? `.${ext}` : ''],
    year: [year]
  };
  const candidates = (field ? [[field, groups[field] || []]] : Object.entries(groups))
    .flatMap(([label, values]) => values.map(value => ({ label, value: String(value || '').trim() })))
    .filter(candidate => candidate.value);
  const match = candidates.find(candidate => terms.every(term => normalizeText(candidate.value).includes(term))) ||
    candidates.find(candidate => terms.some(term => normalizeText(candidate.value).includes(term)));
  if (!match) return null;
  return {
    text: `${match.label}: ${match.value}`,
    terms: terms.filter(term => normalizeText(match.value).includes(term))
  };
}

function appendHighlighted(element, text, terms) {
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
  const match = badge.querySelector('.file-context-match');
  const key = reason ? `${reason.text}\u0000${reason.terms.join('\u0001')}` : '';
  if (badge.dataset.reasonKey === key) return;
  badge.dataset.reasonKey = key;
  badge.classList.toggle('has-match', Boolean(reason));
  if (!match) return;
  if (reason) appendHighlighted(match, reason.text, reason.terms);
  else match.replaceChildren();
}

function currentSearch() {
  return String(window.mochimonoSearch?.raw?.() ?? search?.value ?? '').trim();
}

function loadReason(card, badge) {
  clearTimeout(reasonTimer);
  const raw = currentSearch();
  if (!raw) {
    reasonGeneration++;
    renderReason(badge, null);
    return;
  }
  const hash = card.dataset.hash;
  const filename = card.dataset.filename || 'File';
  if (detailsCache.has(hash)) return renderReason(badge, searchReason(detailsCache.get(hash), raw, filename));
  renderReason(badge, null);
  const generation = ++reasonGeneration;
  reasonTimer = setTimeout(async () => {
    try {
      const response = await fetch(`/api/files/${hash}/details`);
      if (!response.ok) return;
      const details = await response.json();
      detailsCache.set(hash, details);
      if (generation !== reasonGeneration || currentSearch() !== raw || (pointerHash || lastFocusedHash) !== hash) return;
      const current = files.querySelector(`.file-card[data-hash="${CSS.escape(hash)}"] .file-context-badge`);
      if (current) renderReason(current, searchReason(details, raw, filename));
    } catch {}
  }, 90);
}

function decorate() {
  decorateFrame = 0;
  const grid = currentView() === 'grid';
  const activeHash = pointerHash || lastFocusedHash;
  for (const card of files.querySelectorAll('.file-card[data-hash]')) {
    let badge = card.querySelector('.file-context-badge');
    if (!grid) {
      badge?.remove();
      continue;
    }
    const filename = card.dataset.filename || card.getAttribute('title') || card.querySelector('.card-copy strong')?.textContent || 'File';
    card.dataset.filename = filename;
    card.removeAttribute('title');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'file-context-badge';
      badge.innerHTML = '<span class="file-context-name"></span><span class="file-context-match"></span>';
      card.append(badge);
    }
    const name = badge.querySelector('.file-context-name');
    if (name.textContent !== filename) name.textContent = filename;
    if (card.dataset.hash !== activeHash) renderReason(badge, null);
  }
  for (const card of files.querySelectorAll('[data-hash]')) {
    card.removeAttribute('title');
    card.classList.toggle('context-keyboard-focus', card.dataset.hash === lastFocusedHash);
    card.classList.toggle('context-pointer-hover', card.dataset.hash === pointerHash);
  }
  files.classList.toggle('has-context-hover', Boolean(pointerHash));
  if (grid && activeHash) {
    const active = files.querySelector(`.file-card[data-hash="${CSS.escape(activeHash)}"]`);
    const badge = active?.querySelector('.file-context-badge');
    if (active && badge) loadReason(active, badge);
  }
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

function viewerVerticalCard(direction, hash = currentViewerHash()) {
  if (!hash) return null;
  const cards = renderedCards();
  const current = cards.find(card => card.dataset.hash === hash);
  if (!current) return null;
  const next = verticalCard(cards, current, direction);
  return next !== current ? next : null;
}

function openViewerCard(card) {
  if (!card || !window.mochimonoOpenViewer) return false;
  lastFocusedHash = card.dataset.hash;
  window.mochimonoOpenViewer(lastFocusedHash);
  return true;
}

function navigateViewerVertical(direction) {
  if (viewerVerticalPending) {
    queuedViewerVertical = direction;
    return;
  }

  const startHash = currentViewerHash();
  const direct = viewerVerticalCard(direction, startHash);
  if (direct) return void openViewerCard(direct);

  const bridge = direction > 0 ? viewerNext : viewerPrev;
  if (!startHash || !bridge || bridge.disabled || !window.mochimonoOpenViewer) return;

  viewerVerticalPending = true;
  bridge.click();
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const target = viewer.hidden ? null : viewerVerticalCard(direction, startHash);
    if (target) openViewerCard(target);
    else if (!viewer.hidden && currentViewerHash() !== startHash) window.mochimonoOpenViewer(startHash);

    viewerVerticalPending = false;
    const queued = queuedViewerVertical;
    queuedViewerVertical = 0;
    if (queued && !viewer.hidden) navigateViewerVertical(queued);
  }));
}

function absoluteTopRow(card) {
  const topSentinel = document.querySelector('#top-scroll-sentinel');
  return Boolean(topSentinel?.hidden && verticalCard(renderedCards(), card, -1) === card);
}

function focusCard(card) {
  if (!card) return;
  lastFocusedHash = card.dataset.hash;
  pointerHash = '';
  card.focus({ preventScroll: true });
  if (absoluteTopRow(card)) window.scrollTo({ top: 0, behavior: 'auto' });
  else card.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
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

files.addEventListener('pointermove', event => {
  if (event.pointerType === 'touch') return;
  const card = event.target.closest('.file-card[data-hash]');
  const hash = card?.dataset.hash || '';
  if (hash === pointerHash) return;
  pointerHash = hash;
  reasonGeneration++;
  scheduleDecorate();
});

files.addEventListener('pointerleave', () => {
  if (!pointerHash) return;
  pointerHash = '';
  reasonGeneration++;
  scheduleDecorate();
});

files.addEventListener('focusin', event => {
  const card = event.target.closest('[data-hash]');
  if (!card) return;
  lastFocusedHash = card.dataset.hash;
  reasonGeneration++;
  scheduleDecorate();
});

files.addEventListener('pointerdown', event => {
  const card = event.target.closest('[data-hash]');
  if (!card) return;
  lastFocusedHash = card.dataset.hash;
  reasonGeneration++;
  scheduleDecorate();
});

search?.addEventListener('input', () => {
  reasonGeneration++;
  clearTimeout(reasonTimer);
  scheduleDecorate();
});

document.addEventListener('keydown', event => {
  if (typingTarget(event.target)) return;

  if (!viewer.hidden) {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      event.stopImmediatePropagation();
      navigateViewerVertical(event.key === 'ArrowUp' ? -1 : 1);
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
  reasonGeneration++;
  scheduleDecorate();
}).observe(views, { subtree: true, attributes: true, attributeFilter: ['class'] });

window.addEventListener('mochimono-viewer-return', event => {
  const hash = String(event.detail?.hash || '');
  if (!hash) return;
  lastFocusedHash = hash;
  pointerHash = '';
  reasonGeneration++;
  const card = files.querySelector(`[data-hash="${CSS.escape(hash)}"]`);
  card?.focus({ preventScroll: true });
  scheduleDecorate();
});

scheduleDecorate();
