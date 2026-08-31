const files = document.querySelector('#files');
const views = document.querySelector('#views');
const viewer = document.querySelector('#viewer');
const viewerOpen = document.querySelector('#viewer-open');

let pending = false;
let queuedKey = '';

function currentView() {
  return views?.querySelector('[data-view].active')?.dataset.view || 'grid';
}

function typingTarget(target) {
  return Boolean(target?.closest?.('input,select,textarea,[contenteditable="true"]'));
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
  return cards.find(card => {
    const rect = card.getBoundingClientRect();
    return rect.bottom > 80 && rect.top < innerHeight;
  }) || cards[0];
}

function verticalCard(cards, current, direction) {
  if (!current) return null;
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
    if (score < bestScore) {
      best = card;
      bestScore = score;
    }
  }
  return best;
}

function focusCard(card) {
  if (!card) return false;
  card.focus({ preventScroll: true });
  card.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
  return true;
}

function viewerHash() {
  return viewerOpen?.getAttribute('href')?.match(/\/api\/objects\/([a-f0-9]{64})/)?.[1] || '';
}

function extend(direction) {
  try { return Boolean(window.mochimonoLibrary?.extend?.(direction)); }
  catch { return false; }
}

function afterLayout(callback) {
  requestAnimationFrame(() => requestAnimationFrame(callback));
}

function finishPending() {
  pending = false;
  const key = queuedKey;
  queuedKey = '';
  if (key) navigate(key);
}

function extendThen(direction, callback) {
  if (!extend(direction)) return false;
  pending = true;
  afterLayout(() => {
    try { callback(); }
    finally { finishPending(); }
  });
  return true;
}

function navigateGrid(key) {
  if (currentView() !== 'grid') return false;
  const cards = renderedCards();
  const current = currentCard(cards);
  if (!current) return false;
  const hash = current.dataset.hash;

  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    const direction = key === 'ArrowLeft' ? -1 : 1;
    const index = cards.indexOf(current);
    const direct = cards[index + direction];
    if (direct) return focusCard(direct);
    return extendThen(direction, () => {
      const nextCards = renderedCards();
      const start = nextCards.find(card => card.dataset.hash === hash);
      const nextIndex = nextCards.indexOf(start);
      focusCard(nextCards[nextIndex + direction]);
    });
  }

  if (key === 'ArrowUp' || key === 'ArrowDown') {
    const direction = key === 'ArrowUp' ? -1 : 1;
    const direct = verticalCard(cards, current, direction);
    if (direct) return focusCard(direct);
    return extendThen(direction, () => {
      const nextCards = renderedCards();
      const start = nextCards.find(card => card.dataset.hash === hash);
      focusCard(verticalCard(nextCards, start, direction));
    });
  }

  return false;
}

function navigateViewer(key) {
  if (viewer.hidden || (key !== 'ArrowUp' && key !== 'ArrowDown')) return false;
  const direction = key === 'ArrowUp' ? -1 : 1;
  const hash = viewerHash();
  if (!hash || !window.mochimonoOpenViewer) return false;

  const cards = renderedCards();
  const current = cards.find(card => card.dataset.hash === hash);
  const direct = verticalCard(cards, current, direction);
  if (direct) {
    window.mochimonoOpenViewer(direct.dataset.hash);
    return true;
  }

  return extendThen(direction, () => {
    const nextCards = renderedCards();
    const start = nextCards.find(card => card.dataset.hash === hash);
    const target = verticalCard(nextCards, start, direction);
    if (target) window.mochimonoOpenViewer(target.dataset.hash);
  });
}

function navigate(key) {
  if (pending) {
    queuedKey = key;
    return true;
  }
  return viewer.hidden ? navigateGrid(key) : navigateViewer(key);
}

document.addEventListener('keydown', event => {
  if (typingTarget(event.target)) return;
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
  if (!viewer.hidden && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) return;
  if (viewer.hidden && currentView() !== 'grid') return;

  if (pending || navigate(event.key)) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}, true);
