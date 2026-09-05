const files = document.querySelector('#files');
const viewer = document.querySelector('#viewer');

const DRAG_THRESHOLD = 5;
const CLICK_SUPPRESS_MS = 500;
let drag = null;
let paintFrame = 0;
let suppressClickUntil = 0;

const style = document.createElement('style');
style.textContent = `
.files.grid .file-card,.files.grid .file-card *{user-select:none;-webkit-user-select:none}
.files.grid .file-card img{-webkit-user-drag:none;user-drag:none}
.grid-drag-selection-box{position:fixed;z-index:1000;pointer-events:none;border:1px solid rgba(239,160,154,.95);border-radius:3px;background:rgba(239,160,154,.14);box-shadow:0 0 0 1px rgba(0,0,0,.2),0 4px 18px rgba(0,0,0,.16)}
.file-card.grid-drag-hit:not(.media-card){box-shadow:inset 0 0 0 2px rgba(239,160,154,.78)!important}
.file-card.media-card.grid-drag-hit:after{opacity:.68!important}
html.grid-drag-selecting,html.grid-drag-selecting *{cursor:crosshair!important;user-select:none!important;-webkit-user-select:none!important}
`;
document.head.append(style);

const box = document.createElement('div');
box.className = 'grid-drag-selection-box';
box.hidden = true;
document.body.append(box);

const currentView = () => document.querySelector('#views [data-view].active')?.dataset.view || 'grid';
const blockedStart = target => Boolean(target.closest('[data-select-period],.day-group-control,a,input,select,textarea,[contenteditable="true"]'));

function rectFor(startX, startY, endX, endY) {
  const left = Math.min(startX, endX);
  const top = Math.min(startY, endY);
  return {
    left,
    top,
    right:Math.max(startX, endX),
    bottom:Math.max(startY, endY)
  };
}

function intersects(a, b) {
  return a.right >= b.left && a.left <= b.right && a.bottom >= b.top && a.top <= b.bottom;
}

function snapshotVisibleCards() {
  const result = [];
  for (const element of files.querySelectorAll('.file-card[data-hash]')) {
    const rect = element.getBoundingClientRect();
    if (rect.right < 0 || rect.left > innerWidth || rect.bottom < 0 || rect.top > innerHeight) continue;
    result.push({
      element,
      hash:element.dataset.hash,
      rect:{ left:rect.left, top:rect.top, right:rect.right, bottom:rect.bottom }
    });
  }
  return result;
}

function beginDragSelection(event) {
  drag.active = true;
  drag.cards = snapshotVisibleCards();
  drag.hits = new Set();
  document.documentElement.classList.add('grid-drag-selecting');
  box.hidden = false;
  try { window.getSelection()?.removeAllRanges(); } catch {}
  event.preventDefault();
}

function paint() {
  paintFrame = 0;
  if (!drag?.active) return;
  const area = rectFor(drag.startX, drag.startY, drag.x, drag.y);
  box.style.left = `${area.left}px`;
  box.style.top = `${area.top}px`;
  box.style.width = `${Math.max(1, area.right - area.left)}px`;
  box.style.height = `${Math.max(1, area.bottom - area.top)}px`;

  const nextHits = new Set();
  for (const card of drag.cards) {
    if (!card.element.isConnected) continue;
    const hit = intersects(area, card.rect);
    if (hit) nextHits.add(card.hash);
    if (hit !== drag.hits.has(card.hash)) card.element.classList.toggle('grid-drag-hit', hit);
  }
  drag.hits = nextHits;
}

function schedulePaint() {
  if (!paintFrame) paintFrame = requestAnimationFrame(paint);
}

function cleanupDrag() {
  if (paintFrame) cancelAnimationFrame(paintFrame);
  paintFrame = 0;
  for (const card of drag?.cards || []) card.element.classList.remove('grid-drag-hit');
  document.documentElement.classList.remove('grid-drag-selecting');
  box.hidden = true;
  drag = null;
}

function finishDrag(event, canceled = false) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const active = drag.active;
  if (active) {
    drag.x = event.clientX;
    drag.y = event.clientY;
    paint();
    const hits = [...drag.hits];
    suppressClickUntil = performance.now() + CLICK_SUPPRESS_MS;
    cleanupDrag();
    event.preventDefault();
    if (!canceled && hits.length) window.mochimonoSelection?.add?.(hits);
  } else cleanupDrag();
}

files.addEventListener('dragstart', event => {
  if (currentView() === 'grid' && event.target.closest('.file-card[data-hash]')) event.preventDefault();
}, true);

files.addEventListener('pointerdown', event => {
  if (event.pointerType !== 'mouse' || event.button !== 0 || currentView() !== 'grid' || !viewer?.hidden || blockedStart(event.target)) return;
  drag = {
    pointerId:event.pointerId,
    startX:event.clientX,
    startY:event.clientY,
    x:event.clientX,
    y:event.clientY,
    active:false,
    cards:[],
    hits:new Set()
  };
});

window.addEventListener('pointermove', event => {
  if (!drag || event.pointerId !== drag.pointerId) return;
  drag.x = event.clientX;
  drag.y = event.clientY;
  if (!drag.active) {
    if (Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < DRAG_THRESHOLD) return;
    beginDragSelection(event);
  } else event.preventDefault();
  schedulePaint();
}, { passive:false });

window.addEventListener('pointerup', event => finishDrag(event, false));
window.addEventListener('pointercancel', event => finishDrag(event, true));
window.addEventListener('blur', () => {
  if (!drag) return;
  if (drag.active) suppressClickUntil = performance.now() + CLICK_SUPPRESS_MS;
  cleanupDrag();
});

document.addEventListener('click', event => {
  if (performance.now() >= suppressClickUntil) return;
  if (!event.target.closest('#files')) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);

window.mochimonoGridDragSelection = {
  active:() => Boolean(drag?.active)
};
