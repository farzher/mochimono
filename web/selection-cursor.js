const files = document.querySelector('#files');
let keyboardMode = false;

const style = document.createElement('style');
style.textContent = `
  #files [data-hash].context-keyboard-focus{
    box-shadow:none!important;
    outline:none!important;
  }
  html.keyboard-navigation-active #files [data-hash].context-keyboard-focus{
    outline:2px solid rgba(242,233,229,.94)!important;
    outline-offset:-3px;
  }
  html.keyboard-navigation-active #files .file-row.context-keyboard-focus,
  html.keyboard-navigation-active #files .folder-row.context-keyboard-focus{
    outline-offset:-2px;
  }
  html.keyboard-navigation-active #files [data-hash].context-keyboard-focus.selected{
    outline-color:rgba(255,247,244,.98)!important;
  }
`;
document.head.append(style);

function setKeyboardMode(active) {
  keyboardMode = active;
  document.documentElement.classList.toggle('keyboard-navigation-active', active);
}

function focusedItem() {
  return document.activeElement?.closest?.('#files [data-hash]') || null;
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
