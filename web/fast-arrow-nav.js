const files = document.querySelector('#files');
const viewer = document.querySelector('#viewer');
const commandbar = document.querySelector('.commandbar');
const arrows = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);
const VERTICAL_NEIGHBORS = 128;

let holding = false;
let frozenSentinels = null;

const gridActive = () => Boolean(files?.classList.contains('grid'));

function editingControl(event) {
  const control = event.target?.closest?.('input,select,textarea,[contenteditable="true"]');
  if (!control) return false;
  return !(control.id === 'search' && (event.key === 'ArrowUp' || event.key === 'ArrowDown' || !control.value));
}

function orderedCards() {
  return [...files.querySelectorAll('[data-hash]')];
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
  for (const previous of files.querySelectorAll('.keyboard-cursor')) {
    if (previous !== card) previous.classList.remove('keyboard-cursor');
  }
  card.classList.add('keyboard-cursor');
  document.documentElement.classList.add('keyboard-navigation-active');
  card.focus({ preventScroll: true });
  if (scroll) card.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'nearest' });
  window.mochimonoThumbnails?.prioritize?.([card]);
  return true;
}

function freezeSentinels() {
  if (!frozenSentinels) {
    frozenSentinels = {
      top: document.querySelector('#top-scroll-sentinel'),
      bottom: document.querySelector('#scroll-sentinel')
    };
  }
  if (frozenSentinels.top) frozenSentinels.top.hidden = true;
  if (frozenSentinels.bottom) frozenSentinels.bottom.hidden = true;
}

function releaseSentinels() {
  if (!frozenSentinels) return;
  const { top, bottom } = frozenSentinels;
  frozenSentinels = null;
  const state = window.mochimonoLibrary?.state?.();
  if (top) top.hidden = state ? !state.hasPrevious : true;
  if (bottom) bottom.hidden = state ? !state.hasMore : true;
}

function nearestVertical(cards, current, direction) {
  const rect = current.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  let best = null;
  let bestScore = Infinity;

  for (const card of cards) {
    if (card === current) continue;
    const next = card.getBoundingClientRect();
    if (next.width <= 0 || next.height <= 0) continue;
    const nx = next.left + next.width / 2;
    const ny = next.top + next.height / 2;
    const dy = ny - cy;
    if (direction < 0 ? dy >= -3 : dy <= 3) continue;
    const score = Math.abs(dy) * 4 + Math.abs(nx - cx);
    if (score < bestScore) {
      best = card;
      bestScore = score;
    }
  }
  return best;
}

function verticalTarget(current, direction) {
  const cards = orderedCards();
  const index = cards.indexOf(current);
  if (index < 0) return null;

  const start = direction < 0 ? Math.max(0, index - VERTICAL_NEIGHBORS) : index + 1;
  const end = direction < 0 ? index : Math.min(cards.length, index + 1 + VERTICAL_NEIGHBORS);
  const nearby = nearestVertical(cards.slice(start, end), current, direction);
  if (nearby) return nearby;

  // Extremely wide layouts can contain more than VERTICAL_NEIGHBORS cards per
  // visual row. Keep correctness with a rare full-window fallback instead of
  // maintaining a second cached geometry model.
  return nearestVertical(cards, current, direction);
}

function ensureAdjacentWindow(direction) {
  const library = window.mochimonoLibrary;
  const state = library?.state?.();
  if (!state || !library.ensureIndex) return false;
  const probe = direction < 0 ? state.offset - 1 : state.offset + state.loaded;
  if (probe < 0 || probe >= state.filtered) return false;
  library.ensureIndex(probe);
  freezeSentinels();
  return true;
}

function horizontalTarget(current, direction) {
  let cards = orderedCards();
  let index = cards.indexOf(current);
  if (index < 0) return null;
  let target = cards[index + direction];
  if (target) return target;

  const currentHash = current.dataset.hash || '';
  if (!ensureAdjacentWindow(direction)) return null;
  current = currentHash ? files.querySelector(`[data-hash="${CSS.escape(currentHash)}"]`) : null;
  if (!current) return null;
  cards = orderedCards();
  index = cards.indexOf(current);
  return index >= 0 ? cards[index + direction] || null : null;
}

function navigate(key) {
  let current = selectedCard();
  if (!current) return selectCard(visibleStart());

  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    return selectCard(horizontalTarget(current, key === 'ArrowLeft' ? -1 : 1)) || true;
  }

  const direction = key === 'ArrowUp' ? -1 : 1;
  let target = verticalTarget(current, direction);
  if (target) return selectCard(target);

  const currentHash = current.dataset.hash || '';
  if (!ensureAdjacentWindow(direction)) return true;
  current = currentHash ? files.querySelector(`[data-hash="${CSS.escape(currentHash)}"]`) : null;
  if (!current) return true;
  target = verticalTarget(current, direction);
  return selectCard(target) || selectCard(current);
}

function press(key) {
  if (!arrows.has(key) || !viewer?.hidden || !gridActive()) return false;

  if (!holding) {
    holding = true;
    freezeSentinels();
    const current = selectedCard();
    if (!visible(current)) return selectCard(visibleStart());
  }

  navigate(key);
  return true;
}

function release() {
  holding = false;
  releaseSentinels();
}

function reset(clear = false) {
  release();
  if (!clear) return;
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
  press(event.key);
}, true);

document.addEventListener('keyup', event => {
  if (arrows.has(event.key)) release();
}, true);

window.addEventListener('blur', release);
window.addEventListener('mochimono-viewer-return', event => returnTo(event.detail?.hash));
files?.addEventListener('pointerdown', () => reset(true), true);
