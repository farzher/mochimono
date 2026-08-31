const files = document.querySelector('#files');
let keyboardMode = false;

const style = document.createElement('style');
style.textContent = `
  #files [data-hash].context-keyboard-focus{
    box-shadow:none!important;
    outline:none!important;
  }
  html.keyboard-navigation-active #files [data-hash].context-keyboard-focus{
    outline:1.5px solid rgba(231,220,216,.78)!important;
    outline-offset:-4px;
  }
  html.keyboard-navigation-active #files .file-row.context-keyboard-focus,
  html.keyboard-navigation-active #files .folder-row.context-keyboard-focus{
    outline-offset:-2px;
  }
  html.keyboard-navigation-active #files [data-hash].context-keyboard-focus.selected{
    outline-color:rgba(244,231,227,.9)!important;
  }
`;
document.head.append(style);

function setKeyboardMode(active) {
  keyboardMode = active;
  document.documentElement.classList.toggle('keyboard-navigation-active', active);
}

function syncFromFocus() {
  if (!keyboardMode) return;
  const item = document.activeElement?.closest?.('#files [data-hash]');
  if (!item) setKeyboardMode(false);
}

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
