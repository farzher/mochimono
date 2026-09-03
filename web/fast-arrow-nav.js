const files = document.querySelector('#files');
const viewer = document.querySelector('#viewer');
const commandbar = document.querySelector('.commandbar');
const arrows = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);
const ROW_TOLERANCE = 3;
const THUMB_NEIGHBORS = 8;

let holding = false;
let verticalAnchorX = null;
let repeatFrame = 0;
let pendingKey = '';

const gridActive = () => Boolean(files?.classList.contains('grid'));

function editingControl(event) {
  const control = event.target?.closest?.('input,select,textarea,[contenteditable="true"]');
  if (!control) return false;
  return !(control.id === 'search' && (event.key === 'ArrowUp' || event.key === 'ArrowDown' || !control.value));
}

function orderedCards() {
  return [...files.querySelectorAll('[data-hash]')];
}

function cardWalker(current) {
  if (!current?.isConnected) return null;
  const walker = document.createTreeWalker(files, NodeFilter.SHOW_ELEMENT, {
    acceptNode: node => node.hasAttribute?.('data-hash') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
  });
  walker.currentNode = current;
  return walker;
}

function adjacentCard(current, direction) {
  const walker = cardWalker(current);
  return walker ? direction < 0 ? walker.previousNode() : walker.nextNode() : null;
}

function thumbnailNeighborhood(card) {
  const walker = cardWalker(card);
  if (!walker) return [card];
  const result = [card];
  for (let index = 0, item; index < THUMB_NEIGHBORS && (item = walker.previousNode()); index++) result.push(item);
  walker.currentNode = card;
  for (let index = 0, item; index < THUMB_NEIGHBORS && (item = walker.nextNode()); index++) result.push(item);
  return result;
}

function viewportTop() {
  return (commandbar?.getBoundingClientRect().bottom || 0) + 2;
}

function visible(card) {
  if (!card?.isConnected) return false;
  const rect = card.getBoundingClientRect();
  return rect.bottom > viewportTop() && rect.top < innerHeight;
}

function selectedCard() {
  return document.activeElement?.closest?.('#files [data-hash]') || null;
}

function visibleStart(cards = orderedCards()) {
  const active = selectedCard();
  if (visible(active)) return active;

  let best = null;
  let bestTop = Infinity;
  let bestLeft = Infinity;
  const top = viewportTop();
  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= top || rect.top >= innerHeight) continue;
    if (rect.top < bestTop - 3 || (Math.abs(rect.top - bestTop) <= 3 && rect.left < bestLeft)) {
      best = card;
      bestTop = rect.top;
      bestLeft = rect.left;
    }
  }
  return best || cards[0] || null;
}

function selectCard(card, scroll = true) {
  if (!card) return false;
  const previous = selectedCard();
  if (previous && previous !== card) previous.classList.remove('keyboard-cursor');
  else if (!previous) files.querySelector('.keyboard-cursor')?.classList.remove('keyboard-cursor');
  card.classList.add('keyboard-cursor');
  document.documentElement.classList.add('keyboard-navigation-active');
  card.focus({ preventScroll: true });
  if (scroll) card.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'nearest' });
  window.mochimonoThumbnails?.prioritize?.(thumbnailNeighborhood(card));
  return true;
}

function verticalTarget(current, direction, anchorX) {
  const walker = cardWalker(current);
  if (!walker) return null;
  const currentTop = current.getBoundingClientRect().top;
  const step = direction < 0 ? 'previousNode' : 'nextNode';
  let rowTop = null;
  let best = null;
  let bestHorizontalGap = Infinity;
  let bestCenterDistance = Infinity;

  for (let card = walker[step](); card; card = walker[step]()) {
    const rect = card.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const dy = rect.top - currentTop;
    if (direction < 0 ? dy >= -ROW_TOLERANCE : dy <= ROW_TOLERANCE) continue;

    if (rowTop == null) rowTop = rect.top;
    else if (Math.abs(rect.top - rowTop) > ROW_TOLERANCE) break;

    if (anchorX >= rect.left && anchorX <= rect.right) return card;
    const horizontalGap = anchorX < rect.left ? rect.left - anchorX : anchorX - rect.right;
    const centerDistance = Math.abs(rect.left + rect.width / 2 - anchorX);
    if (horizontalGap < bestHorizontalGap ||
        (horizontalGap === bestHorizontalGap && centerDistance < bestCenterDistance)) {
      best = card;
      bestHorizontalGap = horizontalGap;
      bestCenterDistance = centerDistance;
    }
  }
  return best;
}

function restoreWindowAnchor(hash, top) {
  const restore = () => {
    const card = hash ? files.querySelector(`[data-hash="${CSS.escape(hash)}"]`) : null;
    if (!card) return;
    const delta = card.getBoundingClientRect().top - top;
    if (Math.abs(delta) > .5) scrollBy(0, delta);
  };
  restore();
  requestAnimationFrame(() => requestAnimationFrame(restore));
}

function ensureAdjacentWindow(current, direction) {
  const library = window.mochimonoLibrary;
  if (!current?.isConnected || !library?.extend) return false;
  const hash = current.dataset.hash || '';
  const top = current.getBoundingClientRect().top;
  if (!library.extend(direction)) return false;
  window.mochimonoGallery?.layoutNow?.();
  restoreWindowAnchor(hash, top);
  return true;
}

function horizontalTarget(current, direction) {
  const target = adjacentCard(current, direction);
  if (target) return target;

  const currentHash = current.dataset.hash || '';
  if (!ensureAdjacentWindow(current, direction)) return null;
  current = currentHash ? files.querySelector(`[data-hash="${CSS.escape(currentHash)}"]`) : null;
  return current ? adjacentCard(current, direction) : null;
}

function navigate(key) {
  let current = selectedCard();
  if (!current) return selectCard(visibleStart());

  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    verticalAnchorX = null;
    return selectCard(horizontalTarget(current, key === 'ArrowLeft' ? -1 : 1)) || true;
  }

  const direction = key === 'ArrowUp' ? -1 : 1;
  if (!Number.isFinite(verticalAnchorX)) {
    const rect = current.getBoundingClientRect();
    verticalAnchorX = rect.left + rect.width / 2;
  }
  let target = verticalTarget(current, direction, verticalAnchorX);
  if (target) return selectCard(target);

  const currentHash = current.dataset.hash || '';
  if (!ensureAdjacentWindow(current, direction)) return true;
  current = currentHash ? files.querySelector(`[data-hash="${CSS.escape(currentHash)}"]`) : null;
  if (!current) return true;
  target = verticalTarget(current, direction, verticalAnchorX);
  return selectCard(target) || selectCard(current);
}

function press(key) {
  if (!arrows.has(key) || !viewer?.hidden || !gridActive()) return false;
  window.mochimonoGridInteraction?.pulse?.(180);

  if (!holding) {
    holding = true;
    const current = selectedCard();
    if (!visible(current)) {
      verticalAnchorX = null;
      return selectCard(visibleStart());
    }
  }

  navigate(key);
  return true;
}

function queueRepeat(key) {
  pendingKey = key;
  if (repeatFrame) return;
  repeatFrame = requestAnimationFrame(() => {
    repeatFrame = 0;
    const next = pendingKey;
    pendingKey = '';
    if (next && holding) press(next);
  });
}

function release() {
  holding = false;
  pendingKey = '';
  if (repeatFrame) cancelAnimationFrame(repeatFrame);
  repeatFrame = 0;
  window.mochimonoThumbnails?.clearPriority?.();
  window.mochimonoGridInteraction?.release?.();
}

function reset(clear = false) {
  release();
  if (!clear) return;
  verticalAnchorX = null;
  files.querySelector('.keyboard-cursor')?.classList.remove('keyboard-cursor');
  document.documentElement.classList.remove('keyboard-navigation-active');
}

function returnTo(hash) {
  reset(true);
  const value = String(hash || '');
  const card = value ? files.querySelector(`[data-hash="${CSS.escape(value)}"]`) : null;
  if (card && gridActive()) selectCard(card, false);
}

window.mochimonoGridKeyboard = { press, release, reset };

document.addEventListener('keydown', event => {
  if (!arrows.has(event.key) || !viewer?.hidden || !gridActive() || editingControl(event)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (event.repeat) queueRepeat(event.key);
  else press(event.key);
}, true);

document.addEventListener('keyup', event => {
  if (arrows.has(event.key)) release();
}, true);

window.addEventListener('blur', release);
window.addEventListener('mochimono-viewer-return', event => returnTo(event.detail?.hash));
files?.addEventListener('pointermove', event => {
  if (event.pointerType !== 'touch' && document.documentElement.classList.contains('keyboard-navigation-active')) reset(true);
}, true);
files?.addEventListener('pointerdown', () => reset(true), true);
