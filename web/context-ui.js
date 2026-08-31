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
const detailsCache = new Map();

const style = document.createElement('style');
style.textContent = `
  .files.grid .file-card{position:relative}
  .files.grid .file-card:not(.media-card){flex:0 0 auto;width:clamp(calc(var(--media-size) * .65),calc(var(--media-size) * 1.333),calc(var(--media-size) * 2.1));height:var(--media-size);background:#100f11;border-radius:3px}
  .files.grid .file-card:not(.media-card) .thumb{width:100%;height:100%;display:grid;place-items:center}
  .files.grid .file-card:not(.media-card) .card-copy{display:none}
  .file-context-badge{position:absolute;z-index:3;left:0;right:0;bottom:0;min-width:0;padding:28px 8px 7px;display:flex;align-items:baseline;gap:7px;background:linear-gradient(to bottom,transparent 0,rgba(5,5,6,.3) 35%,rgba(5,5,6,.9) 100%);color:#fff;font-size:10px;font-weight:720;line-height:1.2;pointer-events:none;text-shadow:0 1px 3px #000;opacity:0;transform:translateY(3px);transition:opacity .1s ease,transform .1s ease}
  .file-context-name,.file-context-match{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .file-context-name{flex:1 1 auto}
  .file-context-badge.has-match .file-context-name{flex:0 1 44%;max-width:44%}
  .file-context-match{flex:1 1 auto;color:#c9c0bd;font-weight:600}
  .file-context-match mark{padding:0;background:transparent;color:#ff6f67;font-weight:800;text-shadow:0 1px 3px #000}
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
  return String(text || '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function words(text) {
  return normalizeText(text).split(' ').filter(Boolean);
}

function searchTokens(raw) {
  const tokens = [];
  const regex = /(?:^|\s)(?:(name|path|source|type|ext|year):(?:"([^"]*)"|'([^']*)'|([^\s]+))|"([^"]*)"|'([^']*)'|([^\s]+))/giu;
  let match;
  while ((match = regex.exec(String(raw || '')))) {
    const field = match[1]?.toLowerCase() || '';
    const text = match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6] ?? match[7] ?? '';
    if (text.trim()) tokens.push({ field, text: text.trim() });
  }
  return tokens;
}

function sourcePath(source) {
  const root = String(source.rootPath || '').replace(/[\\/]+$/, '');
  const relative = String(source.path || '').replace(/^[\\/]+/, '');
  if (!root) return relative;
  if (!relative) return root;
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  return `${root}${separator}${relative.replace(/[\\/]+/g, separator)}`;
}

function extension(name) {
  return String(name || '').match(/\.([^.]+)$/)?.[1] || '';
}

function detailType(details, filename) {
  const mime = String(details?.object?.mime || '');
  const base = mime.split('/')[0];
  if (base && base !== 'application') return base;
  const ext = extension(filename).toLowerCase();
  if (['jpg','jpeg','png','gif','webp','heic','heif','avif','bmp','tif','tiff'].includes(ext)) return 'image';
  if (['mp4','m4v','mov','mkv','webm','avi','mpg','mpeg','m2v','mts','m2ts','3gp'].includes(ext)) return 'video';
  if (['mp3','m4a','aac','wav','flac','ogg','opus'].includes(ext)) return 'audio';
  if (base === 'text') return 'text';
  return base || 'file';
}

function typeAlias(text) {
  const value = normalizeText(text);
  const aliases = new Map([
    ['photo','image'],['photos','image'],['picture','image'],['pictures','image'],['images','image'],
    ['videos','video'],['movies','video'],['music','audio'],['documents','application'],['document','application'],['docs','application']
  ]);
  return aliases.get(value) || value;
}

function containsTerms(text, terms) {
  const haystack = normalizeText(text);
  return terms.length > 0 && terms.every(term => haystack.includes(term));
}

function unique(values) {
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];
}

function searchReason(details, raw, filename) {
  const tokens = searchTokens(raw);
  if (!tokens.length) return null;
  const sources = Array.isArray(details?.sources) ? details.sources : [];
  const paths = unique(sources.flatMap(source => [sourcePath(source), source.path, source.rootPath]));
  const names = unique([filename, ...sources.map(source => source.filename)]);
  const sourceNames = unique(sources.flatMap(source => [source.sourceName, source.deviceName]));
  const type = detailType(details, filename);
  const ext = extension(filename);
  const date = new Date(details?.date?.fileDate || details?.object?.createdAt || 0);
  const year = Number.isNaN(date.getTime()) ? '' : String(date.getFullYear());

  const fieldReason = token => {
    let terms = words(token.text);
    if (!terms.length) return null;
    if (token.field === 'path') {
      const text = paths.find(value => containsTerms(value, terms));
      return text ? { text, terms } : null;
    }
    if (token.field === 'source') {
      const text = sourceNames.find(value => containsTerms(value, terms));
      return text ? { text, terms } : null;
    }
    if (token.field === 'type') {
      const wanted = typeAlias(token.text);
      const matches = wanted === 'media' ? ['image','video'].includes(type) : wanted === 'application' ? ['application','text'].includes(type) : type === wanted;
      return matches ? { text: type, terms: [wanted === 'media' || wanted === 'application' ? type : wanted] } : null;
    }
    if (token.field === 'ext') {
      terms = words(String(token.text).replace(/^\./, ''));
      return containsTerms(ext, terms) ? { text: `.${ext}`, terms } : null;
    }
    if (token.field === 'year') return containsTerms(year, terms) ? { text: year, terms } : null;
    if (token.field === 'name') {
      const text = names.find(value => containsTerms(value, terms));
      return text && normalizeText(text) !== normalizeText(filename) ? { text, terms } : null;
    }
    return null;
  };

  for (const token of tokens) {
    if (!token.field) continue;
    const reason = fieldReason(token);
    if (reason) return reason;
  }

  const genericTerms = tokens.filter(token => !token.field).flatMap(token => words(token.text));
  if (genericTerms.length) {
    const path = paths.find(value => containsTerms(value, genericTerms));
    if (path) return { text: path, terms: genericTerms };
    const sourceName = sourceNames.find(value => containsTerms(value, genericTerms));
    if (sourceName) return { text: sourceName, terms: genericTerms };
    if (containsTerms(type, genericTerms)) return { text: type, terms: genericTerms };
    if (containsTerms(ext, genericTerms)) return { text: `.${ext}`, terms: genericTerms };
    if (containsTerms(year, genericTerms)) return { text: year, terms: genericTerms };
  }

  for (const token of tokens.filter(token => !token.field)) {
    const terms = words(token.text);
    const path = paths.find(value => containsTerms(value, terms));
    if (path) return { text: path, terms };
    const sourceName = sourceNames.find(value => containsTerms(value, terms));
    if (sourceName) return { text: sourceName, terms };
  }
  return null;
}

function appendHighlighted(element, text, terms) {
  element.replaceChildren();
  const wanted = unique(terms).sort((a, b) => b.length - a.length);
  if (!wanted.length) {
    element.textContent = text;
    return;
  }
  const escaped = wanted.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
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

function clearReason(badge) {
  const match = badge.querySelector('.file-context-match');
  if (!badge.classList.contains('has-match') && !badge.dataset.reasonKey && !match?.childNodes.length) return;
  badge.classList.remove('has-match');
  badge.dataset.reasonKey = '';
  if (match?.childNodes.length) match.replaceChildren();
}

function renderReason(badge, reason) {
  const match = badge.querySelector('.file-context-match');
  if (!match || !reason) return clearReason(badge);
  const key = `${reason.text}\u0000${reason.terms.join('\u0001')}`;
  if (badge.dataset.reasonKey === key) return;
  badge.classList.add('has-match');
  badge.dataset.reasonKey = key;
  appendHighlighted(match, reason.text, reason.terms);
}

function currentSearch() {
  return String(window.mochimonoSearch?.raw?.() ?? search?.value ?? '').trim();
}

function loadReason(card, badge) {
  clearTimeout(reasonTimer);
  const raw = currentSearch();
  if (!raw || !card) {
    reasonGeneration++;
    clearReason(badge);
    return;
  }

  const hash = card.dataset.hash;
  const filename = card.dataset.filename || 'File';
  const cached = detailsCache.get(hash);
  if (cached) {
    renderReason(badge, searchReason(cached, raw, filename));
    return;
  }

  clearReason(badge);
  const generation = ++reasonGeneration;
  reasonTimer = setTimeout(async () => {
    try {
      const response = await fetch(`/api/files/${hash}/details`);
      if (!response.ok) return;
      const details = await response.json();
      detailsCache.set(hash, details);
      if (generation !== reasonGeneration || currentSearch() !== raw) return;
      const activeHash = pointerHash || lastFocusedHash;
      if (activeHash !== hash) return;
      const current = files.querySelector(`.file-card[data-hash="${CSS.escape(hash)}"] .file-context-badge`);
      if (current) renderReason(current, searchReason(details, raw, filename));
    } catch {}
  }, 90);
}

function decorate() {
  decorateFrame = 0;
  const grid = currentView() === 'grid';
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
    if (card.dataset.hash !== (pointerHash || lastFocusedHash)) clearReason(badge);
  }
  for (const card of files.querySelectorAll('[data-hash]')) {
    card.removeAttribute('title');
    card.classList.toggle('context-keyboard-focus', card.dataset.hash === lastFocusedHash);
    card.classList.toggle('context-pointer-hover', card.dataset.hash === pointerHash);
  }
  files.classList.toggle('has-context-hover', Boolean(pointerHash));

  if (grid) {
    const activeHash = pointerHash || lastFocusedHash;
    const active = activeHash ? files.querySelector(`.file-card[data-hash="${CSS.escape(activeHash)}"]`) : null;
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

function bridgeViewerGrid(direction, startHash) {
  const bridge = direction > 0 ? viewerNext : viewerPrev;
  if (!bridge || bridge.disabled || !window.mochimonoOpenViewer) return null;

  // A linear step past the rendered window makes app.js recenter the Grid
  // synchronously. We then navigate from the original card before paint.
  bridge.click();
  if (viewer.hidden) return null;

  const target = viewerVerticalCard(direction, startHash);
  if (target) return target;

  // The bridge step is only an implementation detail. Never leave the viewer
  // on it if there truly is no spatial row in this direction.
  window.mochimonoOpenViewer(startHash);
  return null;
}

function absoluteTopRow(card) {
  const topSentinel = document.querySelector('#top-scroll-sentinel');
  if (!topSentinel?.hidden) return false;
  const cards = renderedCards();
  return verticalCard(cards, card, -1) === card;
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
      const direction = event.key === 'ArrowUp' ? -1 : 1;
      const startHash = currentViewerHash();
      const target = viewerVerticalCard(direction) || bridgeViewerGrid(direction, startHash);
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
