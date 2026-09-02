const viewer = document.querySelector('#viewer');
const viewerOpen = document.querySelector('#viewer-open');
const viewerClose = document.querySelector('#viewer-close');
const viewerPrev = document.querySelector('#viewer-prev');
const viewerNext = document.querySelector('#viewer-next');
const viewerInfo = document.querySelector('#viewerInfo');
const files = document.querySelector('#files');

const arrows = new Set(['ArrowLeft','ArrowRight','ArrowDown','ArrowUp']);
const RAPID_MS = 90;
let rapidUntil = 0;
let settleTimer = 0;
let queuedDirection = 0;
let navFrame = 0;
const settleCallbacks = new Set();

const rapid = () => performance.now() < rapidUntil;
const currentHash = () => viewerOpen?.getAttribute('href')?.match(/\/api\/objects\/([a-f0-9]{64})/)?.[1] || '';

function scheduleSettle() {
  if (settleTimer) return;
  settleTimer = setTimeout(settle, Math.max(0, rapidUntil - performance.now()) + 3);
}

function settle() {
  settleTimer = 0;
  const wait = rapidUntil - performance.now();
  if (wait > 0) {
    settleTimer = setTimeout(settle, wait + 3);
    return;
  }
  const callbacks = [...settleCallbacks];
  settleCallbacks.clear();
  for (const callback of callbacks) callback();
}

function defer(callback) {
  if (typeof callback !== 'function' || !rapid()) return false;
  settleCallbacks.add(callback);
  scheduleSettle();
  return true;
}

window.mochimonoViewerPerformance = { rapid, defer };

function navigateOne(direction) {
  if (viewer.hidden) return false;
  const button = direction < 0 ? viewerPrev : viewerNext;
  if (!button || button.disabled) return false;
  if (typeof button.onclick === 'function') button.onclick.call(button);
  else button.click();
  return true;
}

function flushNavigation() {
  navFrame = 0;
  const direction = queuedDirection;
  queuedDirection = 0;
  if (!direction || viewer.hidden) return;
  navigateOne(direction);
  navFrame = requestAnimationFrame(flushNavigation);
}

function queueNavigation(direction) {
  rapidUntil = performance.now() + RAPID_MS;
  queuedDirection = direction;
  scheduleSettle();
  if (navFrame) return;
  const first = queuedDirection;
  queuedDirection = 0;
  if (!navigateOne(first)) return;
  navFrame = requestAnimationFrame(flushNavigation);
}

function prepareGridReturn() {
  if (!files || viewer?.hidden) return;
  const hash = currentHash();
  files.querySelector(`[data-hash="${CSS.escape(hash)}"]`)?.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'nearest' });
}

document.addEventListener('keydown', event => {
  if (!viewer || viewer.hidden) return;
  if (event.key === 'Escape') {
    if (!document.querySelector('dialog[open]') && (!viewerInfo || viewerInfo.hidden)) prepareGridReturn();
    return;
  }
  if (!arrows.has(event.key)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  queueNavigation(event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1);
}, true);

document.addEventListener('keyup', event => {
  if (!arrows.has(event.key)) return;
  queuedDirection = 0;
  cancelAnimationFrame(navFrame);
  navFrame = 0;
  rapidUntil = Math.min(rapidUntil, performance.now() + 24);
  clearTimeout(settleTimer);
  settleTimer = 0;
  scheduleSettle();
}, true);

viewerClose?.addEventListener('click', prepareGridReturn, true);
if (viewer) new MutationObserver(() => {
  if (!viewer.hidden) return;
  queuedDirection = 0;
  cancelAnimationFrame(navFrame);
  navFrame = 0;
  rapidUntil = 0;
  clearTimeout(settleTimer);
  settleTimer = 0;
  settleCallbacks.clear();
}).observe(viewer, { attributes: true, attributeFilter: ['hidden'] });
