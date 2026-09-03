const viewer = document.querySelector('#viewer');
const commandbar = document.querySelector('.commandbar');
const pageKeys = new Set(['PageUp', 'PageDown']);

function editingControl(target) {
  return Boolean(target?.closest?.('input,select,textarea,[contenteditable="true"]'));
}

function press(key) {
  if (!pageKeys.has(key) || (viewer && !viewer.hidden)) return false;
  const top = Math.max(0, commandbar?.getBoundingClientRect().bottom || 0);
  const distance = Math.max(160, innerHeight - top - 36);
  window.mochimonoGridInteraction?.pulse?.(180);
  scrollBy({ top: key === 'PageUp' ? -distance : distance, left: 0, behavior: 'auto' });
  setTimeout(() => window.mochimonoGridInteraction?.release?.(), 70);
  return true;
}

window.mochimonoPageKeys = { press };

document.addEventListener('keydown', event => {
  if (!pageKeys.has(event.key) || editingControl(event.target) || !press(event.key)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);
