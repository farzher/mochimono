const files = document.querySelector('#files');
let cursorHash = '';

const style = document.createElement('style');
style.textContent = `
  #files [data-hash].selection-cursor{
    position:relative;
    z-index:7;
    outline:3px solid #fff!important;
    outline-offset:-3px;
    box-shadow:0 0 0 2px rgba(0,0,0,.9),0 0 0 5px rgba(255,255,255,.88)!important;
    animation:selection-cursor-in .16s cubic-bezier(.22,1,.36,1);
  }
  #files .file-card.media-card.selection-cursor:after{
    opacity:1!important;
    box-shadow:inset 0 0 0 4px #fff!important;
  }
  #files .file-card.media-card.selection-cursor:before{
    border-color:#fff!important;
    background:#fff!important;
    color:#171518!important;
    box-shadow:0 0 0 2px rgba(0,0,0,.72),0 2px 8px rgba(0,0,0,.55)!important;
  }
  #files .file-row.selection-cursor,
  #files .folder-row.selection-cursor{
    outline-offset:-3px;
  }
  @keyframes selection-cursor-in{
    0%{box-shadow:0 0 0 0 rgba(255,255,255,0)!important}
    65%{box-shadow:0 0 0 2px rgba(0,0,0,.9),0 0 0 7px rgba(255,255,255,1)!important}
    100%{box-shadow:0 0 0 2px rgba(0,0,0,.9),0 0 0 5px rgba(255,255,255,.88)!important}
  }
  @media(prefers-reduced-motion:reduce){
    #files [data-hash].selection-cursor{animation:none}
  }
`;
document.head.append(style);

function applyCursor() {
  for (const item of files?.querySelectorAll('[data-hash].selection-cursor') || []) {
    item.classList.remove('selection-cursor');
  }
  if (!cursorHash || !document.documentElement.classList.contains('selection-active')) return;
  const item = files?.querySelector(`[data-hash="${CSS.escape(cursorHash)}"]`);
  if (item?.classList.contains('selected')) item.classList.add('selection-cursor');
}

// Capture before library-ui stops the selection click from propagating.
// The visual update runs on the next frame, after library-ui has applied the
// selected/selection-active state.
document.addEventListener('click', event => {
  const item = event.target.closest('#files [data-hash]');
  if (item) {
    cursorHash = item.dataset.hash || '';
    requestAnimationFrame(applyCursor);
    return;
  }
  if (event.target.closest('[data-select-period],#selectAll,#selectionClear,#selectFiles')) {
    cursorHash = '';
    requestAnimationFrame(applyCursor);
  }
}, true);

new MutationObserver(() => {
  if (!document.documentElement.classList.contains('selection-active')) cursorHash = '';
  applyCursor();
}).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

new MutationObserver(applyCursor).observe(files, { childList: true, subtree: true });
