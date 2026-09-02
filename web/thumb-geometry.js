const files = document.querySelector('#files');
const pending = new Map();

function applyGeometry(hash, width, height) {
  window.mochimonoLibrary?.rememberDimensions?.(hash, width, height);
}

function learn(image) {
  if (!(image instanceof HTMLImageElement) || !image.classList.contains('cached-thumb')) return;
  if (!image.complete || !image.naturalWidth || !image.naturalHeight) return;
  const card = image.closest('.media-card[data-hash]');
  if (!card) return;

  const ratio = Math.max(.65, Math.min(2.1, image.naturalWidth / image.naturalHeight));
  const current = Number(card.style.getPropertyValue('--ratio')) || 0;
  if (Math.abs(current - ratio) < .001) return;

  const geometry = { hash: card.dataset.hash, width: image.naturalWidth, height: image.naturalHeight };
  if (window.mochimonoGridInteraction?.active?.()) {
    pending.set(geometry.hash, geometry);
    return;
  }
  applyGeometry(geometry.hash, geometry.width, geometry.height);
}

function flushPending() {
  const learned = [...pending.values()];
  pending.clear();
  for (const item of learned) applyGeometry(item.hash, item.width, item.height);
}

files?.addEventListener('load', event => learn(event.target), true);
window.addEventListener('mochimono:grid-interaction-end', flushPending);
for (const image of files?.querySelectorAll('img.cached-thumb') || []) learn(image);
