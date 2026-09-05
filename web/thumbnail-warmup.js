const files = document.querySelector('#files');
const stable = window.mochimonoStableGrid;
const modelIndexes = new WeakMap();

let timer = 0;
let timerAt = 0;
let dirty = false;
let lastScrollAt = 0;
let anchor = null;

function modelIndex(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.items)) return null;
  let index = modelIndexes.get(snapshot);
  if (!index) {
    index = new Map(snapshot.items.map((item, position) => [String(item?.[0] || ''), position]));
    modelIndexes.set(snapshot, index);
  }
  return index;
}

function captureAnchor() {
  if (!files || !stable?.active?.()) return null;
  const top = (document.querySelector('.commandbar')?.getBoundingClientRect().bottom || 0) + 2;
  let best = null;
  let distance = Infinity;
  for (const card of files.querySelectorAll('.stable-grid-row [data-hash]')) {
    const rect = card.getBoundingClientRect();
    if (rect.bottom <= top || rect.top >= innerHeight) continue;
    const next = Math.abs(rect.top - top);
    if (next >= distance) continue;
    distance = next;
    best = { hash:String(card.dataset.hash || ''), top:rect.top };
  }
  return best;
}

function interacting() {
  return Boolean(window.mochimonoGridInteraction?.active?.()) ||
    document.querySelector('#dateRail')?.classList.contains('dragging') ||
    performance.now() - lastScrollAt < 420;
}

function schedule(delay = 220) {
  if (!dirty) return;
  const at = performance.now() + delay;
  if (timer && timerAt <= at) return;
  if (timer) clearTimeout(timer);
  timerAt = at;
  timer = setTimeout(flush, delay);
}

function flush() {
  timer = 0;
  timerAt = 0;
  if (!dirty) return;
  if (interacting()) {
    schedule(300);
    return;
  }

  const snapshot = window.mochimonoGridModel;
  if (!snapshot?.items?.length || !stable?.setModel) {
    schedule(300);
    return;
  }

  dirty = false;
  anchor = captureAnchor();
  stable.setModel(snapshot);
}

function updateDimensions(hash, width, height) {
  hash = String(hash || '');
  width = Number(width) || 0;
  height = Number(height) || 0;
  if (!hash || width <= 0 || height <= 0) return false;

  const snapshot = window.mochimonoGridModel;
  const position = modelIndex(snapshot)?.get(hash);
  if (!Number.isInteger(position)) return false;

  const item = snapshot.items[position];
  if (!item || (Number(item[3]) === width && Number(item[4]) === height)) return false;
  item[3] = width;
  item[4] = height;
  dirty = true;
  schedule();
  return true;
}

if (stable) stable.updateDimensions = updateDimensions;

window.addEventListener('scroll', () => {
  lastScrollAt = performance.now();
  if (dirty) schedule(460);
}, { passive:true });

window.addEventListener('mochimono:grid-interaction-end', () => {
  if (dirty) schedule(220);
});

window.addEventListener('mochimono:stable-grid-installed', () => {
  const restore = anchor;
  anchor = null;
  if (!restore?.hash) return;
  const snapshot = window.mochimonoGridModel;
  const index = modelIndex(snapshot)?.get(restore.hash);
  if (!Number.isInteger(index)) return;
  requestAnimationFrame(() => {
    stable?.ensureIndex?.(index);
    const card = files?.querySelector(`[data-hash="${CSS.escape(restore.hash)}"]`);
    if (!card) return;
    const delta = card.getBoundingClientRect().top - restore.top;
    if (Math.abs(delta) > .5) scrollBy(0, delta);
  });
});

addEventListener('beforeunload', () => {
  if (timer) clearTimeout(timer);
}, { once:true });
