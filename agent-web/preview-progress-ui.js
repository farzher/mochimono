const folders = document.querySelector('#folders');
const folderSection = document.querySelector('.storage-folders-section');

const style = document.createElement('style');
style.textContent = `
  .preview-mode-row{display:flex;align-items:center;justify-content:flex-end;gap:10px;margin:9px 2px 13px;padding:0 2px;color:#847d7d}
  .preview-mode-copy{display:flex;align-items:center;gap:7px;min-width:0}
  .preview-mode-copy strong{color:#aaa19f;font-size:10px;line-height:1;font-weight:650}
  .preview-mode-copy span{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#6f696a;font-size:9px;line-height:1}
  .preview-mode-options{display:flex;flex:0 0 auto;padding:2px;border:1px solid #2b272b;border-radius:9px;background:#0b0a0c}
  .preview-mode-options button{height:25px;padding:0 9px;border:0;border-radius:7px;background:transparent;color:#777072;font:650 9px/1 system-ui;cursor:pointer;transition:background .14s ease,color .14s ease,box-shadow .14s ease}
  .preview-mode-options button:hover{color:#d9cfcc}
  .preview-mode-options button.active{background:#272328;color:#eee6e2;box-shadow:0 1px 3px #0008}
  .preview-mode-options button[data-preview-mode="max"].active{background:#39282a;color:#ffd7d1}
  .preview-mode-options button:disabled{cursor:default;opacity:.55}

  #storagePane [data-preview-progress]{display:block;margin-top:10px;padding-top:8px;border-top:1px solid #211e21}
  #storagePane .preview-progress-head{display:flex;align-items:baseline;gap:8px;min-width:0;font-size:9px;line-height:1.2}
  #storagePane .preview-progress-title{flex:0 0 auto;color:#a69d9a;font-weight:650}
  #storagePane [data-preview-progress-text]{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#746e6e}
  #storagePane [data-preview-percent]{flex:0 0 auto;color:#bdb3af;font-variant-numeric:tabular-nums;font-weight:700}
  #storagePane .preview-progress-track{position:relative;height:4px;margin-top:6px;overflow:hidden;border-radius:999px;background:#292429}
  #storagePane .preview-progress-track>i{position:absolute;inset:0;background:#e99b95;transform:scaleX(var(--preview-progress,0));transform-origin:left center;transition:transform .75s cubic-bezier(.22,1,.36,1);will-change:transform}
  #storagePane [data-preview-progress].preview-indeterminate .preview-progress-track>i{width:34%;transform:none;animation:preview-progress-slide 1.35s ease-in-out infinite}
  @keyframes preview-progress-slide{0%{transform:translateX(-110%)}50%{transform:translateX(100%)}100%{transform:translateX(310%)}}

  @media(max-width:600px){
    .preview-mode-row{align-items:flex-end;flex-direction:column;gap:7px;margin-top:8px}
    .preview-mode-copy span{display:none}
    .preview-mode-options{width:100%}.preview-mode-options button{flex:1}
  }
  @media(prefers-reduced-motion:reduce){
    #storagePane .preview-progress-track>i{transition:none!important;animation:none!important}
  }
`;
document.head.append(style);

const modeCopy = {
  off: 'Only while browsing',
  idle: 'Runs when the computer is idle',
  max: 'Finish as fast as possible'
};
let modeControl = null;
let modeDescription = null;
let currentMode = 'idle';

function setMode(mode) {
  mode = ['off','idle','max'].includes(mode) ? mode : 'idle';
  currentMode = mode;
  modeControl?.querySelectorAll('[data-preview-mode]').forEach(button => button.classList.toggle('active', button.dataset.previewMode === mode));
  if (modeDescription) modeDescription.textContent = modeCopy[mode];
  window.dispatchEvent(new CustomEvent('mochimono:preview-mode', { detail: { mode } }));
}
window.mochimonoPreviewMode = () => currentMode;

if (folderSection && folders) {
  modeControl = document.createElement('div');
  modeControl.className = 'preview-mode-row';
  modeControl.innerHTML = `
    <div class="preview-mode-copy"><strong>Preview generation</strong><span data-preview-mode-description>Runs when the computer is idle</span></div>
    <div class="preview-mode-options" role="group" aria-label="Preview generation">
      <button type="button" data-preview-mode="off" title="Only generate missing previews when files are viewed">On demand</button>
      <button type="button" data-preview-mode="idle" title="Generate in the background when Mochimono and your computer are idle">Idle</button>
      <button type="button" data-preview-mode="max" title="Use available CPU and storage throughput to finish previews quickly">Max</button>
    </div>`;
  modeDescription = modeControl.querySelector('[data-preview-mode-description]');
  folders.insertAdjacentElement('afterend', modeControl);

  modeControl.addEventListener('click', async event => {
    const button = event.target.closest('[data-preview-mode]');
    if (!button || button.classList.contains('active')) return;
    const mode = button.dataset.previewMode;
    const previous = currentMode;
    const buttons = [...modeControl.querySelectorAll('button')];
    buttons.forEach(item => item.disabled = true);
    setMode(mode);
    try {
      const response = await fetch('/api/settings', {
        method:'POST',
        headers:{ 'content-type':'application/json' },
        body:JSON.stringify({ thumbnailMode:mode })
      });
      if (!response.ok) throw new Error('Could not change preview mode');
    } catch {
      setMode(previous);
    } finally {
      buttons.forEach(item => item.disabled = false);
    }
  });

  fetch('/api/state').then(response => response.json()).then(state => setMode(state?.settings?.thumbnailMode || 'idle')).catch(() => setMode('idle'));
}
