const folders = document.querySelector('#folders');
const folderSection = document.querySelector('.storage-folders-section');

const style = document.createElement('style');
style.textContent = `
  .preview-mode-row{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:0 0 12px;padding:10px 12px;border:1px solid #292529;border-radius:11px;background:#121114}
  .preview-mode-copy{display:flex;min-width:0;flex-direction:column;gap:2px}
  .preview-mode-copy strong{color:#e2d9d5;font-size:12px;line-height:1.15}
  .preview-mode-copy span{color:#7f7878;font-size:10px;line-height:1.15;white-space:nowrap}
  .preview-mode-options{display:flex;flex:0 0 auto;padding:2px;border:1px solid #302b30;border-radius:9px;background:#0b0a0c}
  .preview-mode-options button{height:27px;padding:0 10px;border:0;border-radius:7px;background:transparent;color:#817a7b;font:650 10px/1 system-ui;cursor:pointer;transition:background .14s ease,color .14s ease,box-shadow .14s ease}
  .preview-mode-options button:hover{color:#d9cfcc}
  .preview-mode-options button.active{background:#282329;color:#f1e8e4;box-shadow:0 1px 3px #0008}
  .preview-mode-options button[data-preview-mode="max"].active{background:#3a292b;color:#ffd8d3}
  .preview-mode-options button:disabled{cursor:default;opacity:.55}
  #storagePane .storage-meta:has([data-preview-progress]){flex-wrap:wrap}
  #storagePane [data-preview-progress]{
    position:relative;display:block;flex:0 0 100%;width:100%;min-width:0;margin-top:9px;padding:0 44px 10px 0;
    overflow:visible!important;text-overflow:clip!important;white-space:nowrap;
    background:linear-gradient(#292429,#292429) left bottom/100% 5px no-repeat;
    color:#8e8683!important;font-size:10px;font-weight:580!important;line-height:1.2
  }
  #storagePane [data-preview-progress]:before{
    content:attr(data-preview-percent)!important;position:absolute;right:0;top:0;margin:0!important;
    color:#c9bfbb!important;font-variant-numeric:tabular-nums;font-weight:730
  }
  #storagePane [data-preview-progress]:after{
    content:'';position:absolute;left:0;bottom:0;width:100%;height:5px;border-radius:999px;
    background:#efa09a;transform:scaleX(var(--preview-progress,0));transform-origin:left center;
    transition:transform .9s cubic-bezier(.22,1,.36,1);will-change:transform
  }
  #storagePane [data-preview-progress].preview-indeterminate{padding-right:0}
  #storagePane [data-preview-progress].preview-indeterminate:before{content:''!important}
  #storagePane [data-preview-progress].preview-indeterminate:after{
    width:34%;transform:none;animation:preview-progress-slide 1.35s ease-in-out infinite
  }
  @keyframes preview-progress-slide{
    0%{transform:translateX(-110%)}50%{transform:translateX(100%)}100%{transform:translateX(310%)}
  }
  @media(max-width:600px){
    .preview-mode-row{align-items:flex-start;flex-direction:column;gap:8px}
    .preview-mode-options{width:100%}.preview-mode-options button{flex:1}
  }
  @media(prefers-reduced-motion:reduce){
    #storagePane [data-preview-progress]:after{transition:none!important;animation:none!important}
  }
`;
document.head.append(style);

const modeCopy = {
  off: 'Generate as you browse',
  idle: 'Background · pauses while in use',
  max: 'Finish as fast as possible'
};
let modeControl = null;
let modeDescription = null;

function setMode(mode) {
  mode = ['off','idle','max'].includes(mode) ? mode : 'idle';
  modeControl?.querySelectorAll('[data-preview-mode]').forEach(button => button.classList.toggle('active', button.dataset.previewMode === mode));
  if (modeDescription) modeDescription.textContent = modeCopy[mode];
}

if (folderSection && folders) {
  modeControl = document.createElement('div');
  modeControl.className = 'preview-mode-row';
  modeControl.innerHTML = `
    <div class="preview-mode-copy"><strong>Previews</strong><span data-preview-mode-description>Background · pauses while in use</span></div>
    <div class="preview-mode-options" role="group" aria-label="Preview generation">
      <button type="button" data-preview-mode="off" title="Only generate previews when files are viewed">On demand</button>
      <button type="button" data-preview-mode="idle" title="Generate in the background when Mochimono and your computer are idle">Idle</button>
      <button type="button" data-preview-mode="max" title="Use available CPU and storage throughput to finish previews quickly">Max</button>
    </div>`;
  modeDescription = modeControl.querySelector('[data-preview-mode-description]');
  folders.before(modeControl);

  modeControl.addEventListener('click', async event => {
    const button = event.target.closest('[data-preview-mode]');
    if (!button || button.classList.contains('active')) return;
    const mode = button.dataset.previewMode;
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
      const state = await fetch('/api/state').then(response => response.json()).catch(() => null);
      setMode(state?.settings?.thumbnailMode || 'idle');
    } finally {
      buttons.forEach(item => item.disabled = false);
    }
  });

  fetch('/api/state').then(response => response.json()).then(state => setMode(state?.settings?.thumbnailMode || 'idle')).catch(() => setMode('idle'));
}

function number(text) {
  return Number(String(text || '').replaceAll(',', '')) || 0;
}

function decorate(node) {
  if (!(node instanceof Element) || !node.matches('[data-preview-progress]')) return;
  const text = String(node.textContent || '').trim();
  const match = text.match(/([\d,]+)\s*\/\s*([\d,]+)/);
  if (match) {
    const done = number(match[1]);
    const total = number(match[2]);
    let ratio = total ? Math.max(0, Math.min(1, done / total)) : 0;
    if (/finishing|checking/i.test(text) && ratio >= 1) ratio = .99;
    node.classList.remove('preview-indeterminate');
    node.dataset.previewPercent = `${Math.floor(ratio * 100)}%`;
    node.style.setProperty('--preview-progress', String(ratio));
    return;
  }

  if (/finding media previews/i.test(text)) {
    node.classList.add('preview-indeterminate');
    node.dataset.previewPercent = '';
    node.style.removeProperty('--preview-progress');
    return;
  }

  const complete = text.match(/^([\d,]+)\s+previews\b/i);
  if (complete) {
    node.classList.remove('preview-indeterminate');
    node.dataset.previewPercent = '100%';
    node.style.setProperty('--preview-progress', '1');
    return;
  }

  node.classList.remove('preview-indeterminate');
  node.dataset.previewPercent = '';
  node.style.removeProperty('--preview-progress');
}

function decorateAll(root = folders) {
  if (!root) return;
  if (root.matches?.('[data-preview-progress]')) decorate(root);
  root.querySelectorAll?.('[data-preview-progress]').forEach(decorate);
}

decorateAll();
if (folders) new MutationObserver(records => {
  const touched = new Set();
  for (const record of records) {
    const target = record.target instanceof Element ? record.target : record.target?.parentElement;
    if (target) touched.add(target.closest?.('[data-preview-progress]') || target);
    for (const node of record.addedNodes) {
      const element = node instanceof Element ? node : node.parentElement;
      if (element) touched.add(element);
    }
  }
  for (const node of touched) decorateAll(node);
}).observe(folders, { childList:true, subtree:true, characterData:true });
