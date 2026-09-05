const viewer = document.querySelector('#viewer');
const commandbar = document.querySelector('.commandbar');
const pageKeys = new Set(['PageUp','PageDown','Home','End']);
let releaseTimer = 0;

function editingControl(target) {
  return Boolean(target?.closest?.('input,select,textarea,[contenteditable="true"]'));
}

function pageDistance() {
  const top = Math.max(0, commandbar?.getBoundingClientRect().bottom || 0);
  return Math.max(180, innerHeight - top - 24);
}

function release() {
  clearTimeout(releaseTimer);
  releaseTimer = 0;
  window.mochimonoThumbnails?.clearPriority?.();
  window.mochimonoGridInteraction?.release?.();
}

function armRelease() {
  clearTimeout(releaseTimer);
  releaseTimer = setTimeout(release, 140);
}

function stablePress(key) {
  const stable = window.mochimonoStableGrid;
  if (!stable?.owns?.()) return false;
  const state = window.mochimonoLibrary?.state?.();
  const count = Number(state?.filtered) || 0;
  if (!count) return false;

  window.mochimonoGridInteraction?.pulse?.(120);
  armRelease();

  if (key === 'Home') {
    stable.scrollToIndex?.(0, 'start');
    return true;
  }
  if (key === 'End') {
    stable.scrollToIndex?.(count - 1, 'end');
    return true;
  }

  const direction = key === 'PageUp' ? -1 : 1;
  const distance = pageDistance();
  const target = Math.max(0, window.scrollY + direction * distance);

  // Native key-repeat is never serialized: each event moves immediately.
  // Thumbnail/row warming happens asynchronously and cannot throttle motion.
  stable.warmViewport?.(target);
  window.scrollTo({ top:target, left:0, behavior:'auto' });
  return true;
}

function press(key) {
  if (!pageKeys.has(key) || (viewer && !viewer.hidden)) return false;
  return stablePress(key);
}

window.mochimonoPageKeys = { press, release };

document.addEventListener('keydown', event => {
  if (!pageKeys.has(event.key) || editingControl(event.target) || !press(event.key)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);

document.addEventListener('keyup', event => {
  if (pageKeys.has(event.key)) release();
}, true);
window.addEventListener('blur', release);
