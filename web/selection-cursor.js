import './context-ui.js';

const files = document.querySelector('#files');
let keyboardMode = false;
let ringFrame = 0;

const style = document.createElement('style');
style.textContent = `
  #files [data-hash].context-keyboard-focus{
    outline:none!important;
  }
  html.keyboard-navigation-active #files [data-hash].context-keyboard-focus:not(.selected){
    box-shadow:none!important;
  }
  html.keyboard-navigation-active #files [data-hash].context-keyboard-focus{
    position:relative;
    transform:translateZ(0);
  }
  .keyboard-cursor-ring{
    position:absolute;
    z-index:20;
    inset:3px;
    border:2px solid rgba(255,255,255,.98);
    border-radius:3px;
    box-shadow:0 0 0 2px rgba(0,0,0,.9),inset 0 0 0 1px rgba(0,0,0,.7);
    pointer-events:none;
  }
  html.keyboard-navigation-active #files .file-row .keyboard-cursor-ring,
  html.keyboard-navigation-active #files .folder-row .keyboard-cursor-ring{
    inset:2px;
    border-width:2px;
    border-radius:4px;
  }
  html.keyboard-navigation-active #files [data-hash].selected .keyboard-cursor-ring{
    inset:6px;
    border-color:#fff;
    box-shadow:0 0 0 1px rgba(0,0,0,.95);
  }
`;
document.head.append(style);

function focusedItem() {
  return document.activeElement?.closest?.('#files [data-hash]') || null;
}

function syncRing() {
  ringFrame = 0;
  files?.querySelectorAll('.keyboard-cursor-ring').forEach(ring => ring.remove());
  if (!keyboardMode) return;
  const item = focusedItem();
  if (!item) return;
  const ring = document.createElement('span');
  ring.className = 'keyboard-cursor-ring';
  ring.setAttribute('aria-hidden', 'true');
  item.append(ring);
}

function scheduleRing() {
  if (!ringFrame) ringFrame = requestAnimationFrame(syncRing);
}

function setKeyboardMode(active) {
  keyboardMode = active;
  document.documentElement.classList.toggle('keyboard-navigation-active', active);
  scheduleRing();
}

function firstVisibleItem() {
  const items = [...files?.querySelectorAll('[data-hash]') || []];
  return items.find(item => {
    const rect = item.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 80 && rect.top < innerHeight;
  }) || items.find(item => {
    const rect = item.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }) || null;
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
  scheduleRing();
  event.preventDefault();
  event.stopImmediatePropagation();
}

function syncFromFocus() {
  if (!keyboardMode) return;
  if (!focusedItem()) setKeyboardMode(false);
  else scheduleRing();
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
  else scheduleRing();
}));

if (files) new MutationObserver(scheduleRing).observe(files, { childList: true, subtree: true });
