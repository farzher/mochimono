const CLIENT = document.documentElement.classList.contains('client-library');
const files = document.querySelector('#files');
const app = document.querySelector('#app');
let banner;
let loaded = 0;
let catalogReady = false;
let loadDetail = {};
let workDetail = null;

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

function render() {
  if (!CLIENT) return;
  const node = ensureBanner();
  if (!node) return;
  // Loading catalog rows and preparing their originals/previews are separate.
  // A successful catalog fetch is never a claim that an import is finished.
  const detail = loadDetail.error ? loadDetail : workDetail || (!catalogReady ? loadDetail : null);
  node.hidden = !detail;
  if (!detail) return;
  loaded = Number(window.mochimonoLibrary?.state?.().total) || loaded;
  node.classList.toggle('error', Boolean(detail.error));
  node.querySelector('strong').textContent = detail.error ? 'Library update failed' : detail.phase || (loaded ? 'Loading library' : 'Opening library');
  node.querySelector('span').textContent = detail.error || detail.message || (loaded ? `${loaded.toLocaleString()} files available` : '');
  node.querySelector('button').hidden = !detail.error;
}

export function updateLibraryLoad(detail = {}) {
  loadDetail = detail;
  if (detail.complete) catalogReady = true;
  render();
}

export function updateLibraryWork(detail) {
  workDetail = detail || null;
  render();
}

window.mochimonoLibraryLoading = { skeleton, update:updateLibraryLoad };

if (CLIENT) {
  if (app) app.hidden = false;
  document.querySelector('#login')?.setAttribute('hidden', '');
  document.documentElement.classList.remove('mochimono-quick-grid-pending');
  if (files && !files.querySelector('.file-card')) files.innerHTML = skeleton();
  ensureBanner();
  const ready = () => {
    if (!window.mochimonoLibrary?.state?.().total) return;
    catalogReady = true;
    render();
  };
  addEventListener('mochimono:catalog-cache-restored', ready);
  addEventListener('mochimono:local-catalog-ready', ready);
}
