import './thumb-geometry.js';
import './fast-arrow-nav.js';
import './context-ui.js';

const files = document.querySelector('#files');
let keyboardMode = false;

const style = document.createElement('style');
style.textContent = `
  #files [data-hash].context-keyboard-focus{outline:none!important}
  html.keyboard-navigation-active #files [data-hash].context-keyboard-focus:not(.selected){
    box-shadow:none!important
  }
  html.keyboard-navigation-active #files [data-hash].context-keyboard-focus{
    position:relative;transform:translateZ(0);
    outline:2px solid rgba(255,255,255,.98)!important;outline-offset:-4px!important;
    box-shadow:inset 0 0 0 2px rgba(0,0,0,.82)!important
  }
  html.keyboard-navigation-active #files .file-row.context-keyboard-focus,
  html.keyboard-navigation-active #files .folder-row.context-keyboard-focus{
    outline-offset:-3px!important;border-radius:4px
  }
  html.keyboard-navigation-active #files [data-hash].selected.context-keyboard-focus{
    outline-offset:-7px!important;box-shadow:inset 0 0 0 1px rgba(0,0,0,.95)!important
  }
`;
document.head.append(style);

function focusedItem() {
  return document.activeElement?.closest?.('#files [data-hash]') || null;
}

function setKeyboardMode(active) {
  keyboardMode = active;
  document.documentElement.classList.toggle('keyboard-navigation-active', active);
}

function firstVisibleItem() {
  const items = [...files?.querySelectorAll('[data-hash]') || []];
  let fallback = null;
  for (const item of items) {
    const rect = item.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    fallback ||= item;
    if (rect.bottom > 80 && rect.top < innerHeight) return item;
  }
  return fallback;
}

function establishKeyboardFocus(event) {
  if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return;
  if (event.target?.closest?.('input,select,textarea,[contenteditable="true"]')) return;
  if (focusedItem()) return;

  const item = firstVisibleItem();
  if (!item) return;
  setKeyboardMode(true);
  if (item.tabIndex < 0) item.tabIndex = 0;
  item.focus({ preventScroll: true });
  item.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
  event.preventDefault();
  event.stopImmediatePropagation();
}

function syncFromFocus() {
  if (!keyboardMode) return;
  if (!focusedItem()) setKeyboardMode(false);
}

window.addEventListener('keydown', establishKeyboardFocus, true);

document.addEventListener('keydown', event => {
  if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return;
  if (event.target?.closest?.('input,select,textarea,[contenteditable="true"]')) return;
  setKeyboardMode(true);
  requestAnimationFrame(syncFromFocus);
}, true);

files?.addEventListener('focusin', () => {
  if (keyboardMode) requestAnimationFrame(syncFromFocus);
});

files?.addEventListener('pointerdown', () => setKeyboardMode(false), true);

files?.addEventListener('focusout', () => requestAnimationFrame(() => {
  if (!files.contains(document.activeElement)) setKeyboardMode(false);
}));
