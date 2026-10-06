const CLIENT = document.documentElement.classList.contains('client-library');
const files = document.querySelector('#files');
const app = document.querySelector('#app');
let banner;
let hideTimer = 0;
let loaded = 0;
let libraryReady = false;

export function skeleton() {
  return `<div class="library-skeleton" aria-hidden="true">${Array.from({ length:18 }, (_, i) => `<span style="--delay:${i % 4 * 120}ms"></span>`).join('')}</div>`;
}

function ensureBanner() {
  if (banner || !files) return banner;
  banner = document.createElement('div');
  banner.className = 'library-loading-status';
  banner.setAttribute('role', 'status');
  banner.innerHTML = '<i aria-hidden="true"></i><strong>Opening library</strong><span></span><button type="button" hidden>Retry</button>';
  banner.querySelector('button').onclick = () => dispatchEvent(new CustomEvent('mochimono:library-retry'));
  files.before(banner);
  return banner;
}

export function updateLibraryLoad(detail = {}) {
  if (!CLIENT) return;
  const node = ensureBanner();
  if (!node) return;
  clearTimeout(hideTimer);
  if (libraryReady && !detail.error) { node.hidden = true; return; }
  node.hidden = false;
  loaded = Number(window.mochimonoLibrary?.state?.().total) || Number(detail.loaded) || loaded;
  node.classList.toggle('complete', Boolean(detail.complete));
  node.classList.toggle('error', Boolean(detail.error));
  node.querySelector('strong').textContent = detail.error ? (libraryReady ? 'Library update failed' : 'Could not load library')
    : detail.phase || (detail.complete ? 'Library ready' : loaded ? 'Loading library' : 'Opening library');
  node.querySelector('span').textContent = detail.error || detail.message || (loaded ? `${loaded.toLocaleString()} files available` : '');
  node.querySelector('button').hidden = !detail.error;
  if (detail.complete) hideTimer = setTimeout(() => { node.hidden = true; }, 2400);
}

window.mochimonoLibraryLoading = { skeleton, update:updateLibraryLoad };

if (CLIENT) {
  // The app frame is usable even with an empty cache or an unavailable server.
  if (app) app.hidden = false;
  document.querySelector('#login')?.setAttribute('hidden', '');
  document.documentElement.classList.remove('mochimono-quick-grid-pending');
  if (files && !files.querySelector('.file-card')) files.innerHTML = skeleton();
  ensureBanner();
  const ready = () => {
    if (!window.mochimonoLibrary?.state?.().total) return;
    libraryReady = true;
    clearTimeout(hideTimer);
    if (banner && !banner.classList.contains('error')) banner.hidden = true;
  };
  addEventListener('mochimono:catalog-cache-restored', ready);
  addEventListener('mochimono:local-catalog-ready', ready);
}
