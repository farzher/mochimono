import './thumb-geometry.js';
import './fast-arrow-nav.js';
import './context-ui.js';

const files = document.querySelector('#files');
let keyboardMode = false;
let syncFrame = 0;

const style = document.createElement('style');
style.textContent = `
  #files [data-hash].keyboard-cursor{outline:none!important}
  html.keyboard-navigation-active #files.grid .file-card.context-keyboard-focus:not(.keyboard-cursor){
    outline:none!important;box-shadow:none!important
  }
  html.keyboard-navigation-active #files.grid .file-card.keyboard-cursor{
    position:relative;z-index:2;outline:none!important;
    box-shadow:inset 0 0 0 3px var(--pink),inset 0 0 0 5px rgba(0,0,0,.72)!important
  }
  html.keyboard-navigation-active #files.grid .file-card.keyboard-cursor::after{
    content:attr(data-filename);position:absolute;z-index:6;left:0;right:0;bottom:0;
    min-width:0;padding:30px 9px 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
    background:linear-gradient(to bottom,transparent 0,rgba(5,5,6,.28) 34%,rgba(5,5,6,.94) 100%);
    color:#fff;font-size:10px;font-weight:760;line-height:1.2;text-shadow:0 1px 3px #000;pointer-events:none
  }
  html.keyboard-navigation-active #files.grid .file-card.keyboard-cursor .file-context-badge{
    opacity:0!important;transition:none!important
  }
  html.keyboard-navigation-active #files.list .file-row.keyboard-cursor,
  html.keyboard-navigation-active #files.folders .folder-row.keyboard-cursor{
    outline:none!important;box-shadow:inset 0 0 0 2px var(--pink)!important;border-radius:4px
  }
`;
document.head.append(style);

function focusedItem() {
  return document.activeElement?.closest?.('#files [data-hash]') || null;
}

function setKeyboardMode(active) {
  keyboardMode = active;
  document.documentElement.classList.toggle('keyboard-navigation-active', active);
  if (!active) files?.querySelector('.keyboard-cursor')?.classList.remove('keyboard-cursor');
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
  files?.querySelector('.keyboard-cursor')?.classList.remove('keyboard-cursor');
  item.classList.add('keyboard-cursor');
  if (item.tabIndex < 0) item.tabIndex = 0;
  item.focus({ preventScroll: true });
  item.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
  event.preventDefault();
  event.stopImmediatePropagation();
}

function syncFromFocus() {
  syncFrame = 0;
  if (!keyboardMode) return;
  if (!focusedItem()) setKeyboardMode(false);
}

function scheduleFocusSync() {
  if (!syncFrame) syncFrame = requestAnimationFrame(syncFromFocus);
}

window.addEventListener('keydown', establishKeyboardFocus, true);

document.addEventListener('keydown', event => {
  if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return;
  if (event.target?.closest?.('input,select,textarea,[contenteditable="true"]')) return;
  setKeyboardMode(true);
  scheduleFocusSync();
}, true);

files?.addEventListener('focusin', () => {
  if (keyboardMode) scheduleFocusSync();
});

files?.addEventListener('pointerdown', () => setKeyboardMode(false), true);
files?.addEventListener('focusout', scheduleFocusSync);
