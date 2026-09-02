const files = document.querySelector('#files');

function learn(image) {
  if (!(image instanceof HTMLImageElement) || !image.classList.contains('cached-thumb')) return;
  if (!image.complete || !image.naturalWidth || !image.naturalHeight) return;
  const card = image.closest('.media-card[data-hash]');
  if (!card) return;

  const ratio = Math.max(.65, Math.min(2.1, image.naturalWidth / image.naturalHeight));
  const current = Number(card.style.getPropertyValue('--ratio')) || 0;
  if (Math.abs(current - ratio) < .001) return;

  window.mochimonoLibrary?.rememberDimensions?.(
    card.dataset.hash,
    image.naturalWidth,
    image.naturalHeight
  );
}

files?.addEventListener('load', event => learn(event.target), true);
for (const image of files?.querySelectorAll('img.cached-thumb') || []) learn(image);
