import './file-context-menu.js';
import './random-sort.js';
import './stable-grid.js';

const files = document.querySelector('#files');
const views = document.querySelector('#views');
const folderbar = document.querySelector('#folderbar');

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

function cancelPress() {
  if (!press) return;
  clearTimeout(press.timer);
  press = null;
}

function startPress(event) {
  if (event.pointerType !== 'touch') return;
  const card = event.target.closest('#files [data-hash]');
  if (!card) return;
  cancelPress();
  const start = { x: event.clientX, y: event.clientY };
  press = {
    pointerId: event.pointerId,
    card,
    start,
    timer: setTimeout(() => {
      if (!press || press.card !== card) return;
      suppressHash = card.dataset.hash || '';
      dispatchingLongPress = true;
      card.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: start.x,
        clientY: start.y,
        button: 2
      }));
      dispatchingLongPress = false;
      cancelPress();
    }, 520)
  };
}

files.addEventListener('pointerdown', startPress, { passive: true });
files.addEventListener('pointermove', event => {
  if (!press || press.pointerId !== event.pointerId) return;
  if (Math.hypot(event.clientX - press.start.x, event.clientY - press.start.y) > 12) cancelPress();
}, { passive: true });
files.addEventListener('pointerup', cancelPress, { passive: true });
files.addEventListener('pointercancel', cancelPress, { passive: true });
files.addEventListener('click', event => {
  const card = event.target.closest('[data-hash]');
  if (!card || !suppressHash || card.dataset.hash !== suppressHash) return;
  suppressHash = '';
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);
files.addEventListener('contextmenu', event => {
  if (dispatchingLongPress) return;
  cancelPress();
}, true);
