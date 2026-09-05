const pageFiles = document.querySelector('#files');
const pageViewer = document.querySelector('#viewer');
const pageCommandbar = document.querySelector('.commandbar');

let pendingPage = 0;
const pageKeyState = { lastKey:'', before:0, target:0, max:0, queued:false, attempts:0 };

function startupGridIncomplete() {
  const cacheCount = Number(window.mochimonoCatalogCache?.state?.().count) || 0;
  const libraryCount = Number(window.mochimonoLibrary?.state?.().total) || 0;
  return Boolean(window.mochimonoStableGrid?.state?.().building) || (libraryCount > 0 && cacheCount < libraryCount);
}

function pageGrid(direction, allowQueue = true) {
  if (!pageViewer?.hidden || !pageFiles?.classList.contains('grid')) return false;
  const top = Math.max(0, pageCommandbar?.getBoundingClientRect().bottom || 0);
  const page = Math.max(240, innerHeight - top);
  const scrolling = document.scrollingElement || document.documentElement;
  const before = scrollY;
  const max = Math.max(0, Number(scrolling?.scrollHeight || 0) - innerHeight);
  const target = Math.max(0, Math.min(max, before + direction * page));

  pageKeyState.before = before;
  pageKeyState.target = target;
  pageKeyState.max = max;
  pageKeyState.attempts++;

  if (Math.abs(target - before) < 1) {
    if (allowQueue && direction > 0 && startupGridIncomplete()) pendingPage = direction;
    pageKeyState.queued = Boolean(pendingPage);
    return false;
  }

  pendingPage = 0;
  pageKeyState.queued = false;
  window.scrollTo({ top:target, left:0, behavior:'auto' });
  return true;
}

function retryPendingPage() {
  if (!pendingPage) return;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (!pendingPage) return;
    pageGrid(pendingPage, false);
  }));
}

document.addEventListener('keydown', event => {
  if ((event.key !== 'PageUp' && event.key !== 'PageDown') || !pageViewer?.hidden || !pageFiles?.classList.contains('grid')) return;
  const control = event.target?.closest?.('input,select,textarea,[contenteditable="true"]');
  if (control && !(control.id === 'search' && !control.value)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  pageKeyState.lastKey = event.key;
  pageGrid(event.key === 'PageDown' ? 1 : -1, true);
}, true);

window.addEventListener('mochimono:stable-grid-installed', retryPendingPage);
window.addEventListener('mochimono:catalog-cache-restored', retryPendingPage);
window.addEventListener('mochimono:catalog-updated', retryPendingPage);
window.mochimonoPageKeys = { state:() => ({ ...pageKeyState, pendingPage }) };
