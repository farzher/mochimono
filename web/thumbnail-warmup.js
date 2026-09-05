const files = document.querySelector('#files');
const THUMB_VERSION = 3;
const WARM_LIMIT = 600;
const warmed = new Map();

const style = document.createElement('style');
style.textContent = `
html.stable-grid-owned img.cached-thumb.mochimono-thumb-fade{opacity:0;transition:opacity 90ms ease-out}
html.stable-grid-owned img.cached-thumb.mochimono-thumb-fade.mochimono-thumb-visible{opacity:1}
@media(prefers-reduced-motion:reduce){html.stable-grid-owned img.cached-thumb.mochimono-thumb-fade{transition:none}}
`;
document.head.append(style);

function rememberWarm(hash, image) {
  if (warmed.has(hash)) warmed.delete(hash);
  warmed.set(hash, image);
  while (warmed.size > WARM_LIMIT) warmed.delete(warmed.keys().next().value);
}

function warmCard(card) {
  if (!card?.classList?.contains('media-card')) return;
  const hash = String(card.dataset.hash || '');
  if (!hash) return;
  const current = warmed.get(hash);
  if (current) {
    rememberWarm(hash, current);
    return;
  }

  const image = new Image();
  image.decoding = 'async';
  image.loading = 'eager';
  image.alt = '';
  try { image.fetchPriority = 'auto'; } catch {}
  image.addEventListener('error', () => {
    if (warmed.get(hash) === image) warmed.delete(hash);
  }, { once:true });
  rememberWarm(hash, image);
  image.src = `/api/thumbs/${hash}?v=${THUMB_VERSION}`;
  image.decode?.().catch(() => {});
}

function fadeImage(image) {
  if (!(image instanceof HTMLImageElement) || !image.classList.contains('cached-thumb')) return;
  const hash = String(image.dataset.thumbHash || '');
  if (hash) warmed.delete(hash);
  if (image.dataset.mochimonoFadeBound === '1') return;
  image.dataset.mochimonoFadeBound = '1';
  image.classList.add('mochimono-thumb-fade');
  const reveal = () => requestAnimationFrame(() => {
    if (image.isConnected) image.classList.add('mochimono-thumb-visible');
  });
  if (image.complete && image.naturalWidth) reveal();
  else image.addEventListener('load', reveal, { once:true });
}

function scan(node) {
  if (!(node instanceof Element)) return;
  if (node.matches('.stable-grid-row')) {
    for (const card of node.querySelectorAll('.media-card[data-hash]')) warmCard(card);
  }
  for (const row of node.querySelectorAll?.('.stable-grid-row') || []) {
    for (const card of row.querySelectorAll('.media-card[data-hash]')) warmCard(card);
  }
  if (node.matches('img.cached-thumb')) fadeImage(node);
  for (const image of node.querySelectorAll?.('img.cached-thumb') || []) fadeImage(image);
}

if (files) {
  scan(files);
  new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) scan(node);
  }).observe(files, { childList:true, subtree:true });
  window.addEventListener('mochimono:stable-grid-installed', () => scan(files));
}
