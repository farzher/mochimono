const files = document.querySelector('#files');
const views = document.querySelector('#views');
const viewer = document.querySelector('#viewer');
const viewerClose = document.querySelector('#viewer-close');
const viewerInfo = document.querySelector('#viewer-info-button');
const viewerOpen = document.querySelector('#viewer-open');

let decorateFrame = 0;
let lastFocusedHash = '';
let pointerHash = '';

const style = document.createElement('style');
style.textContent = `
  .file-card.media-card{position:relative}
  .file-context-badge{position:absolute;z-index:3;left:0;right:0;bottom:0;min-width:0;padding:28px 8px 7px;background:linear-gradient(to bottom,transparent 0,rgba(5,5,6,.3) 35%,rgba(5,5,6,.9) 100%);color:#fff;font-size:10px;font-weight:720;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;text-shadow:0 1px 3px #000;opacity:0;transform:translateY(3px);transition:opacity .1s ease,transform .1s ease}
  .file-card.context-pointer-hover .file-context-badge,
  .file-card.context-keyboard-focus .file-context-badge,
  .file-card:focus-visible .file-context-badge{opacity:1;transform:none}
  .files.has-context-hover .file-card.context-keyboard-focus:not(.context-pointer-hover) .file-context-badge{opacity:0;transform:translateY(3px)}
  .file-card.context-keyboard-focus,.file-row.context-keyboard-focus{box-shadow:0 0 0 3px rgba(239,160,154,.9)!important;outline:none}
  @media(max-width:700px){.file-context-badge{padding:24px 7px 6px;font-size:9px}}
`;
document.head.append(style);

function currentView() {
  return views.querySelector('[data-view].active')?.dataset.view || 'grid';
}

function decorate() {
  decorateFrame = 0;
  const grid = currentView() === 'grid';
  for (const card of files.querySelectorAll('.file-card.media-card[data-hash]')) {
    let badge = card.querySelector('.file-context-badge');
    if (!grid) {
      badge?.remove();
      continue;
    }
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'file-context-badge';
      card.append(badge);
    }
    badge.textContent = card.dataset.filename || 'File';
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

scheduleDecorate();
