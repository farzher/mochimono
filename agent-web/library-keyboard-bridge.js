const frame = document.querySelector('#filesFrame');
const filesPane = document.querySelector('#filesPane');
const pageKeys = new Set(['PageUp', 'PageDown', 'Home', 'End']);

addEventListener('keydown', event => {
  if (!pageKeys.has(event.key) || filesPane?.hidden || document.querySelector('dialog[open]')) return;
  if (event.target?.closest?.('input,select,textarea,[contenteditable="true"]')) return;
  if (!frame?.contentWindow?.mochimonoPageKeys?.press?.(event.key)) return;
  frame.contentWindow.focus();
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);
