import './file-context-menu.js';
import './random-sort.js';
import './viewer-grid-return.js';

const files = document.querySelector('#files');
const views = document.querySelector('#views');
const folderbar = document.querySelector('#folderbar');
const viewer = document.querySelector('#viewer');
const commandbar = document.querySelector('.commandbar');

const currentView = () => views.querySelector('[data-view].active')?.dataset.view || 'grid';
const syncLayoutMode = () => document.documentElement.classList.toggle('library-grid-view', currentView() === 'grid');

views.addEventListener('click', syncLayoutMode);
syncLayoutMode();

folderbar.addEventListener('click', event => {
  if (!event.target.closest('[data-folder-home]') || currentView() === 'folders') return;
  const url = new URL(location.href);
  url.searchParams.delete('source');
  url.searchParams.delete('path');
  history.replaceState(history.state, '', url);
  requestAnimationFrame(() => {
    folderbar.hidden = true;
    folderbar.replaceChildren();
  });
});

let pendingPage = 0;
const pagingState = { lastKey:'', before:0, target:0, max:0, queued:false, attempts:0 };

function startupGridIncomplete() {
  const cacheCount = Number(window.mochimonoCatalogCache?.state?.().count) || 0;
  const libraryCount = Number(window.mochimonoLibrary?.state?.().total) || 0;
  return Boolean(window.mochimonoStableGrid?.state?.().building) || (libraryCount > 0 && cacheCount < libraryCount);
}

function pageGrid(direction, allowQueue = true) {
  if (!viewer?.hidden || !files?.classList.contains('grid')) return false;
  const top = Math.max(0, commandbar?.getBoundingClientRect().bottom || 0);
  const page = Math.max(240, innerHeight - top);
  const scrolling = document.scrollingElement || document.documentElement;
  const before = scrollY;
  const max = Math.max(0, Number(scrolling?.scrollHeight || 0) - innerHeight);
  const target = Math.max(0, Math.min(max, before + direction * page));

  pagingState.before = before;
  pagingState.target = target;
  pagingState.max = max;
  pagingState.attempts++;

  if (Math.abs(target - before) < 1) {
    if (allowQueue && direction > 0 && startupGridIncomplete()) pendingPage = direction;
    pagingState.queued = Boolean(pendingPage);
    return false;
  }

  pendingPage = 0;
  pagingState.queued = false;
  window.scrollTo({ top:target, left:0, behavior:'auto' });
  return true;
}

function retryPendingPage() {
  if (!pendingPage) return;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (!pendingPage) return;
    const direction = pendingPage;
    pageGrid(direction, false);
  }));
}

// Page keys are app-owned so focus never determines whether the grid can page.
// During the quick startup snapshot there may not be a second viewport yet; keep
// one PageDown intent and apply it as soon as the complete stable grid is installed.
document.addEventListener('keydown', event => {
  if ((event.key !== 'PageUp' && event.key !== 'PageDown') || !viewer?.hidden || !files?.classList.contains('grid')) return;
  const control = event.target?.closest?.('input,select,textarea,[contenteditable="true"]');
  if (control && !(control.id === 'search' && !control.value)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  pagingState.lastKey = event.key;
  pageGrid(event.key === 'PageDown' ? 1 : -1, true);
}, true);

window.addEventListener('mochimono:stable-grid-installed', retryPendingPage);
window.addEventListener('mochimono:catalog-cache-restored', retryPendingPage);
window.addEventListener('mochimono:catalog-updated', retryPendingPage);
window.mochimonoPageKeys = { state:() => ({ ...pagingState, pendingPage }) };

// Escape closes the top-most dialog before the viewer/application sees it.
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  const dialog = [...document.querySelectorAll('dialog[open]')].at(-1);
  if (!dialog) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  dialog.close();
}, true);

let press = null;
let dispatchingLongPress = false;
let suppressHash = '';
let suppressUntil = 0;

function cancelPress() {
  if (press?.timer) clearTimeout(press.timer);
  press = null;
}

files.addEventListener('pointerdown', event => {
  if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
  const item = event.target.closest('[data-hash]');
  if (!item) return;
  cancelPress();
  const hash = item.dataset.hash;
  press = {
    pointerId: event.pointerId,
    hash,
    x: event.clientX,
    y: event.clientY,
    timer: setTimeout(() => {
      if (!press || press.hash !== hash) return;
      suppressHash = hash;
      suppressUntil = performance.now() + 900;
      dispatchingLongPress = true;
      item.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        clientX: press.x,
        clientY: press.y
      }));
      dispatchingLongPress = false;
      navigator.vibrate?.(8);
      cancelPress();
    }, 500)
  };
}, { passive: true });

files.addEventListener('pointermove', event => {
  if (!press || event.pointerId !== press.pointerId) return;
  if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 12) cancelPress();
}, { passive: true });
files.addEventListener('pointerup', cancelPress, { passive: true });
files.addEventListener('pointercancel', cancelPress, { passive: true });

files.addEventListener('click', event => {
  if (dispatchingLongPress) return;
  const item = event.target.closest('[data-hash]');
  if (!item || item.dataset.hash !== suppressHash || performance.now() > suppressUntil) return;
  suppressHash = '';
  suppressUntil = 0;
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);

files.addEventListener('contextmenu', event => {
  const item = event.target.closest('[data-hash]');
  if (item && item.dataset.hash === suppressHash && performance.now() <= suppressUntil) event.preventDefault();
});
