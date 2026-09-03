const folders = document.querySelector('#folders');

const style = document.createElement('style');
style.textContent = `
  #storagePane [data-preview-progress]{
    position:relative;display:block;min-width:0;margin-top:9px;padding:0 44px 10px 0;
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
  @media(prefers-reduced-motion:reduce){
    #storagePane [data-preview-progress]:after{transition:none!important;animation:none!important}
  }
`;
document.head.append(style);

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
    const ratio = total ? Math.max(0, Math.min(1, done / total)) : 0;
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
    if (record.target instanceof Element) touched.add(record.target.closest?.('[data-preview-progress]') || record.target);
    for (const node of record.addedNodes) if (node instanceof Element) touched.add(node);
  }
  for (const node of touched) decorateAll(node);
}).observe(folders, { childList:true, subtree:true, characterData:true });
