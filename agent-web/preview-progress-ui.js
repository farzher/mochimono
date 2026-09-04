const folders = document.querySelector('#folders');
const headActions = document.querySelector('.client-head-actions');
const serverStorage = document.querySelector('#serverStorage');

const style = document.createElement('style');
style.textContent = `
  .preview-mode-row{position:relative;flex:0 0 auto}
  .preview-mode-row>summary{height:31px;display:flex;align-items:center;gap:6px;padding:0 9px;border:1px solid transparent;border-radius:8px;color:#8d8584;cursor:pointer;list-style:none;white-space:nowrap;font-size:10px;font-weight:650;transition:background .14s ease,border-color .14s ease,color .14s ease}
  .preview-mode-row>summary::-webkit-details-marker{display:none}
  .preview-mode-row>summary:hover,.preview-mode-row[open]>summary{border-color:#2d292d;background:#211e22;color:#eee7e3}
  .preview-mode-row>summary span{color:#777072;font-weight:580}
  .preview-mode-row>summary strong{color:inherit;font-size:10px;font-weight:730}
  .preview-mode-row>summary:after{content:'⌄';margin-left:1px;color:#686164;font-size:10px;line-height:1;transform:translateY(-1px)}
  .preview-mode-row[open]>summary:after{transform:rotate(180deg) translateY(1px)}
  .preview-mode-popover{position:absolute;right:0;top:38px;z-index:45;width:260px;padding:6px;border:1px solid #302b30;border-radius:11px;background:#171518;box-shadow:0 16px 46px rgba(0,0,0,.46)}
  .preview-mode-popover button{position:relative;width:100%;min-height:43px;display:grid;gap:2px;padding:8px 31px 8px 9px;border:0;border-radius:7px;background:transparent;color:#c8bfbc;text-align:left;cursor:pointer}
  .preview-mode-popover button:hover{background:#252126;color:#fff}
  .preview-mode-popover button.active{background:#252126;color:#fff}
  .preview-mode-popover button.active:after{content:'✓';position:absolute;right:10px;top:50%;transform:translateY(-50%);color:#efa09a;font-size:12px;font-weight:800}
  .preview-mode-popover button strong{font-size:11px;font-weight:700;color:inherit}
  .preview-mode-popover button span{font-size:9px;font-weight:550;line-height:1.25;color:#817978}
  .preview-mode-popover button:hover span,.preview-mode-popover button.active span{color:#aaa19e}
  .preview-mode-popover button:disabled{cursor:default;opacity:.55}

  #storagePane [data-preview-progress]{display:block;margin-top:10px;padding-top:8px;border-top:1px solid #211e21}
  #storagePane .preview-progress-head{display:flex;align-items:baseline;gap:8px;min-width:0;font-size:9px;line-height:1.2}
  #storagePane .preview-progress-title{flex:0 0 auto;color:#a69d9a;font-weight:650}
  #storagePane [data-preview-progress-text]{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#746e6e}
  #storagePane [data-preview-percent]{flex:0 0 auto;color:#bdb3af;font-variant-numeric:tabular-nums;font-weight:700}
  #storagePane .preview-progress-track{position:relative;height:4px;margin-top:6px;overflow:hidden;border-radius:999px;background:#292429}
  #storagePane .preview-progress-track>i{position:absolute;inset:0;background:#e99b95;transform:scaleX(var(--preview-progress,0));transform-origin:left center;transition:transform .75s cubic-bezier(.22,1,.36,1);will-change:transform}
  #storagePane [data-preview-progress].preview-indeterminate .preview-progress-track>i{width:34%;transform:none;animation:preview-progress-slide 1.35s ease-in-out infinite}
  @keyframes preview-progress-slide{0%{transform:translateX(-110%)}50%{transform:translateX(100%)}100%{transform:translateX(310%)}}

  @media(max-width:700px){
    .preview-mode-row>summary{padding:0 7px}
    .preview-mode-row>summary span{display:none}
    .preview-mode-popover{right:-2px;width:244px}
  }
  @media(prefers-reduced-motion:reduce){
    #storagePane .preview-progress-track>i{transition:none!important;animation:none!important}
  }
`;
document.head.append(style);

const modeLabel = {
  off: 'On demand',
  idle: 'Idle',
  max: 'Max'
};
let modeControl = null;
let modeValue = null;
let currentMode = 'idle';

function setMode(mode) {
  mode = ['off','idle','max'].includes(mode) ? mode : 'idle';
  currentMode = mode;
  modeControl?.querySelectorAll('[data-preview-mode]').forEach(button => button.classList.toggle('active', button.dataset.previewMode === mode));
  if (modeValue) modeValue.textContent = modeLabel[mode];
  window.dispatchEvent(new CustomEvent('mochimono:preview-mode', { detail: { mode } }));
}
window.mochimonoPreviewMode = () => currentMode;

if (headActions) {
  modeControl = document.createElement('details');
  modeControl.className = 'preview-mode-row';
  modeControl.innerHTML = `
    <summary title="Background work"><span>Background</span><strong data-preview-mode-value>Idle</strong></summary>
    <div class="preview-mode-popover" role="group" aria-label="Background work">
      <button type="button" data-preview-mode="off" title="Do not automatically scan, sync, or generate thumbnails"><strong>On demand</strong><span>Only run expensive work when you ask</span></button>
      <button type="button" data-preview-mode="idle" title="Run folder sync, indexing, and thumbnail work only when this computer is idle"><strong>Idle</strong><span>Wait until the computer is idle · recommended</span></button>
      <button type="button" data-preview-mode="max" title="Run pending sync, indexing, and thumbnail work immediately"><strong>Max</strong><span>Finish pending background work now</span></button>
    </div>`;
  modeValue = modeControl.querySelector('[data-preview-mode-value]');
  if (serverStorage) serverStorage.insertAdjacentElement('afterend', modeControl);
  else headActions.prepend(modeControl);

  modeControl.addEventListener('click', async event => {
    const button = event.target.closest('[data-preview-mode]');
    if (!button || button.classList.contains('active')) return;
    const mode = button.dataset.previewMode;
    const previous = currentMode;
    const buttons = [...modeControl.querySelectorAll('button')];
    buttons.forEach(item => item.disabled = true);
    setMode(mode);
    modeControl.open = false;
    try {
      const response = await fetch('/api/settings', {
        method:'POST',
        headers:{ 'content-type':'application/json' },
        body:JSON.stringify({ thumbnailMode:mode })
      });
      if (!response.ok) throw new Error('Could not change background mode');
    } catch {
      setMode(previous);
    } finally {
      buttons.forEach(item => item.disabled = false);
    }
  });

  document.addEventListener('pointerdown', event => {
    if (modeControl.open && !modeControl.contains(event.target)) modeControl.open = false;
  });

  fetch('/api/state').then(response => response.json()).then(state => setMode(state?.settings?.thumbnailMode || 'idle')).catch(() => setMode('idle'));
}
