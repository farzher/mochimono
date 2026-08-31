const files = document.querySelector('#files');
let keyboardCursor = '';
let keyboardMode = false;

const style = document.createElement('style');
style.textContent = `
  #files [data-hash]{position:relative}
  .keyboard-cursor-marker{
    position:absolute;
    z-index:9;
    right:7px;
    top:7px;
    width:8px;
    height:8px;
    border-radius:50%;
    background:rgba(232,224,220,.88);
    box-shadow:0 0 0 2px rgba(10,9,11,.72);
    pointer-events:none;
    animation:keyboard-cursor-in .12s ease-out;
  }
  .file-row .keyboard-cursor-marker,.folder-row .keyboard-cursor-marker{right:8px;top:50%;transform:translateY(-50%)}
  @keyframes keyboard-cursor-in{from{opacity:.2;transform:scale(.7)}to{opacity:1;transform:scale(1)}}
  @media(prefers-reduced-motion:reduce){.keyboard-cursor-marker{animation:none}}
`;
document.head.append(style);

function clearMarkers() {
  files?.querySelectorAll('.keyboard-cursor-marker').forEach(marker => marker.remove());
}

function applyCursor() {
  clearMarkers();
  if (!keyboardMode || !keyboardCursor) return;
  const item = files?.querySelector(`[data-hash="${CSS.escape(keyboardCursor)}"]`);
  if (!item) return;
  const marker = document.createElement('span');
  marker.className = 'keyboard-cursor-marker';
  marker.setAttribute('aria-hidden', 'true');
  item.append(marker);
}

function syncFromFocus() {
  const item = document.activeElement?.closest?.('#files [data-hash]');
  if (!item) return;
  keyboardCursor = item.dataset.hash || '';
  applyCursor();
}

document.addEventListener('keydown', event => {
  if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return;
  if (event.target?.closest?.('input,select,textarea,[contenteditable="true"]')) return;
  keyboardMode = true;
  requestAnimationFrame(syncFromFocus);
}, true);

files?.addEventListener('focusin', event => {
  if (!keyboardMode) return;
  const item = event.target.closest('[data-hash]');
  if (!item) return;
  keyboardCursor = item.dataset.hash || '';
  applyCursor();
});

files?.addEventListener('pointerdown', () => {
  keyboardMode = false;
  keyboardCursor = '';
  clearMarkers();
}, true);

files?.addEventListener('focusout', () => requestAnimationFrame(() => {
  if (files.contains(document.activeElement)) return;
  keyboardMode = false;
  keyboardCursor = '';
  clearMarkers();
}));

new MutationObserver(applyCursor).observe(files, { childList: true, subtree: true });
