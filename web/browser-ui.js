const files = document.querySelector('#files');
const views = document.querySelector('#views');
const folderbar = document.querySelector('#folderbar');
const dateRail = document.querySelector('#dateRail');

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

const railTopHit = document.createElement('div');
railTopHit.hidden = true;
railTopHit.setAttribute('aria-hidden', 'true');
Object.assign(railTopHit.style, {
  position: 'fixed', top: '0', width: '0', height: '0', zIndex: '6', background: 'transparent',
  cursor: 'ns-resize', touchAction: 'none', userSelect: 'none'
});
document.body.append(railTopHit);

function syncRailTopHit() {
  if (dateRail.hidden) {
    railTopHit.hidden = true;
    return;
  }
  const rect = dateRail.getBoundingClientRect();
  if (rect.top <= 0 || rect.width <= 0) {
    railTopHit.hidden = true;
    return;
  }
  railTopHit.hidden = false;
  railTopHit.style.right = `${Math.max(0, innerWidth - rect.right)}px`;
  railTopHit.style.width = `${rect.width}px`;
  railTopHit.style.height = `${rect.top}px`;
}

let railTopFrame = 0;
function scheduleRailTopHit() {
  if (railTopFrame) return;
  railTopFrame = requestAnimationFrame(() => {
    railTopFrame = 0;
    syncRailTopHit();
  });
}

function forwardRailPointer(type, event, forceTop = false) {
  if (dateRail.hidden) return;
  const rect = dateRail.getBoundingClientRect();
  const clientY = forceTop ? rect.top : Math.max(rect.top, Math.min(rect.bottom, event.clientY));
  const capture = dateRail.setPointerCapture;
  const release = dateRail.releasePointerCapture;
  dateRail.setPointerCapture = () => {};
  dateRail.releasePointerCapture = () => {};
  try {
    dateRail.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: event.pointerType || 'mouse',
      isPrimary: true,
      button: 0,
      buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
      clientX: Math.max(rect.left, rect.right - 1),
      clientY
    }));
  } finally {
    if (capture) dateRail.setPointerCapture = capture;
    else delete dateRail.setPointerCapture;
    if (release) dateRail.releasePointerCapture = release;
    else delete dateRail.releasePointerCapture;
  }
}

let railTopPointer = null;
railTopHit.addEventListener('pointerdown', event => {
  if (dateRail.hidden) return;
  railTopPointer = event.pointerId;
  try { railTopHit.setPointerCapture(event.pointerId); } catch {}
  forwardRailPointer('pointerdown', event, true);
  event.preventDefault();
});
railTopHit.addEventListener('pointermove', event => {
  if (event.pointerId !== railTopPointer) return;
  forwardRailPointer('pointermove', event);
  event.preventDefault();
});
railTopHit.addEventListener('pointerup', event => {
  if (event.pointerId !== railTopPointer) return;
  forwardRailPointer('pointerup', event);
  try { railTopHit.releasePointerCapture(event.pointerId); } catch {}
  railTopPointer = null;
  event.preventDefault();
});
railTopHit.addEventListener('pointercancel', event => {
  if (event.pointerId !== railTopPointer) return;
  forwardRailPointer('pointercancel', event);
  railTopPointer = null;
});

new MutationObserver(scheduleRailTopHit).observe(dateRail, { attributes: true, attributeFilter: ['hidden'] });
window.addEventListener('resize', scheduleRailTopHit, { passive: true });
scheduleRailTopHit();

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
