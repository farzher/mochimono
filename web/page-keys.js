const viewer = document.querySelector('#viewer');
const commandbar = document.querySelector('.commandbar');
const pageKeys = new Set(['PageUp','PageDown','Home','End']);

function editingControl(target) {
  return Boolean(target?.closest?.('input,select,textarea,[contenteditable="true"]'));
}

function pageDistance() {
  const top = Math.max(0, commandbar?.getBoundingClientRect().bottom || 0);
  return Math.max(180, innerHeight - top - 24);
}

function stablePress(key) {
  const stable = window.mochimonoStableGrid;
  if (!stable?.owns?.()) return false;
  const count = Number(stable.count?.()) || 0;
  if (!count) return false;

  if (key === 'Home') return Boolean(stable.scrollToIndex?.(0, 'start'));
  if (key === 'End') return Boolean(stable.scrollToIndex?.(count - 1, 'end'));

  const direction = key === 'PageUp' ? -1 : 1;
  const target = Math.max(0, window.scrollY + direction * pageDistance());

  // Materialize the destination from the already-complete geometry before the
  // browser moves. No worker request, thumbnail wait, RAF, or virtual-window
  // extension is on the PageUp/PageDown path.
  stable.prepareViewport?.(target);
  window.scrollTo({ top:target, left:0, behavior:'auto' });
  return true;
}

function press(key) {
  if (!pageKeys.has(key) || (viewer && !viewer.hidden)) return false;
  return stablePress(key);
}

window.mochimonoPageKeys = { press, release() {} };

document.addEventListener('keydown', event => {
  if (!pageKeys.has(event.key) || editingControl(event.target) || !press(event.key)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);