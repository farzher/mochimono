const files = document.querySelector('#files');
let keyboardCursor = '';
let keyboardMode = false;

const style = document.createElement('style');
style.textContent = `
  #files .file-card.media-card.context-keyboard-focus,
  #files .file-row.context-keyboard-focus,
  #files .folder-row.context-keyboard-focus{box-shadow:none!important;outline:none!important}
  #files .file-card:not(.media-card).context-keyboard-focus{box-shadow:none!important;outline:none!important}
  #files .file-card:not(.media-card).context-keyboard-focus.selected{box-shadow:inset 0 0 0 2px var(--pink)!important}
  #files [data-hash]{position:relative}
  .keyboard-cursor-marker{
    position:absolute;
    z-index:9;
    right:7px;
    top:7px;
    width:8px;
    height:8px;
    border-radius:50%;
    background:rgba(216,207,203,.9);
    box-shadow:0 0 0 2px rgba(10,9,11,.68);
    pointer-events:none;
  }
  .file-row .keyboard-cursor-marker,.folder-row .keyboard-cursor-marker{right:8px;top:50%;transform:translateY(-50%)}
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

new MutationObserver(mutations => {
  const galleryChanged = mutations.some(mutation =>
    [...mutation.addedNodes, ...mutation.removedNodes].some(node =>
      !(node instanceof Element && node.classList.contains('keyboard-cursor-marker'))
    )
  );
  if (galleryChanged) requestAnimationFrame(applyCursor);
}).observe(files, { childList: true, subtree: true });
