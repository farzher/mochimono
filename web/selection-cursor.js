const files = document.querySelector('#files');
let cursorHash = '';

const style = document.createElement('style');
style.textContent = `
  #files [data-hash].selection-cursor{
    outline:2px solid rgba(255,255,255,.96)!important;
    outline-offset:-5px;
    z-index:7;
    animation:selection-cursor-in .14s cubic-bezier(.22,1,.36,1);
  }
  #files .file-row.selection-cursor,
  #files .folder-row.selection-cursor{
    outline-offset:-3px;
  }
  @keyframes selection-cursor-in{
    from{outline-color:rgba(255,255,255,.15)}
    to{outline-color:rgba(255,255,255,.96)}
  }
  @media(prefers-reduced-motion:reduce){
    #files [data-hash].selection-cursor{animation:none}
  }
`;
document.head.append(style);

function applyCursor() {
  for (const item of files?.querySelectorAll('[data-hash].selection-cursor') || []) {
    if (item.dataset.hash !== cursorHash) item.classList.remove('selection-cursor');
  }
  if (!cursorHash || !document.documentElement.classList.contains('selection-active')) return;
  files?.querySelector(`[data-hash="${CSS.escape(cursorHash)}"]`)?.classList.add('selection-cursor');
}

document.addEventListener('click', event => {
  const item = event.target.closest('#files [data-hash]');
  if (item && document.documentElement.classList.contains('selection-active')) {
    cursorHash = item.dataset.hash || '';
    requestAnimationFrame(applyCursor);
    return;
  }
  if (event.target.closest('[data-select-period],#selectAll,#selectionClear,#selectFiles')) {
    cursorHash = '';
    requestAnimationFrame(applyCursor);
  }
});

new MutationObserver(() => {
  if (!document.documentElement.classList.contains('selection-active')) cursorHash = '';
  applyCursor();
}).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

new MutationObserver(applyCursor).observe(files, { childList: true, subtree: true });
