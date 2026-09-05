const sizeInput = document.querySelector('#mediaSize');
const sizeButtons = [...document.querySelectorAll('[data-media-size]')];

function mediaSize() {
  return Number(sizeInput?.value) || 170;
}

function syncSizeButtons() {
  const size = mediaSize();
  sizeButtons.forEach(button => button.classList.toggle('active', Number(button.dataset.mediaSize) === size));
}

function setMediaSize(size) {
  if (!sizeInput) return;
  sizeInput.value = String(size);
  sizeInput.dispatchEvent(new Event('input', { bubbles:true }));
}

for (const button of sizeButtons) {
  button.addEventListener('click', () => setMediaSize(Number(button.dataset.mediaSize)));
}

sizeInput?.addEventListener('input', syncSizeButtons);
window.addEventListener('mochimono:media-size', syncSizeButtons);

// Compatibility for old keyboard code. Geometry is no longer discovered by
// observing or rebuilding DOM; stable-grid.js is the only grid layout owner.
window.mochimonoGallery = { layoutNow:() => false };
syncSizeButtons();
