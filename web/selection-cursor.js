const files = document.querySelector('#files');
let keyboardMode = false;

const style = document.createElement('style');
style.textContent = `
  #files [data-hash].context-keyboard-focus{
    outline:1.5px solid rgba(231,220,216,.78)!important;
    outline-offset:-4px;
  }
  #files .file-row.context-keyboard-focus,
  #files .folder-row.context-keyboard-focus{
    outline-offset:-2px;
  }
  #files [data-hash].context-keyboard-focus.selected{
    outline-color:rgba(244,231,227,.9)!important;
  }
`;
document.head.append(style);

function clearKeyboardFocus() {
  files?.querySelectorAll('.context-keyboard-focus').forEach(item => item.classList.remove('context-keyboard-focus'));
}

function syncFromFocus() {
  if (!keyboardMode) return;
  const item = document.activeElement?.closest?.('#files [data-hash]');
  clearKeyboardFocus();
  item?.classList.add('context-keyboard-focus');
}

document.addEventListener('keydown', event => {
  if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return;
  if (event.target?.closest?.('input,select,textarea,[contenteditable="true"]')) return;
  keyboardMode = true;
  requestAnimationFrame(syncFromFocus);
}, true);

files?.addEventListener('focusin', () => {
  if (keyboardMode) requestAnimationFrame(syncFromFocus);
});

files?.addEventListener('pointerdown', () => {
  keyboardMode = false;
  clearKeyboardFocus();
}, true);

files?.addEventListener('focusout', () => requestAnimationFrame(() => {
  if (files.contains(document.activeElement)) return;
  keyboardMode = false;
  clearKeyboardFocus();
}));
