const storage = document.querySelector('#storagePane');
const folders = document.querySelector('#folders');

const style = document.createElement('style');
style.textContent = `
  #storagePane{width:min(980px,calc(100% - 36px));gap:34px;padding-top:16px}
  #storagePane .section-head{min-height:48px}
  #storagePane .section-head h2{font-size:17px}

  .storage-add-button{height:36px;display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:0 12px;border-radius:9px;background:#eee8e4;color:#171316;font-size:12px;font-weight:720;white-space:nowrap}
  .storage-add-button:hover{background:#fff}
  .storage-add-button>span{font-size:17px;font-weight:400;line-height:1;margin-top:-1px}
  .storage-add-button.secondary-add{height:32px;padding:0 9px;background:#242124;color:#d8cfcb;font-size:11px}
  .storage-add-button.secondary-add:hover{background:#302b30;color:#fff}
  .storage-add-button.secondary-add>span{font-size:15px}

  /* Folder choice is now direct: Add folder opens the picker and adds Local. */
  #folderAdd{display:none!important}

  #storagePane .folder-item{padding:14px 4px;gap:18px}
  #storagePane .folder-item.has-folder-preview{grid-template-columns:250px minmax(0,1fr) auto;min-height:164px;align-items:center}
  #storagePane .folder-item.has-folder-preview .storage-folder-samples{width:250px;height:136px;border-radius:13px}
  #storagePane .folder-item .storage-copy{align-self:center}
  #storagePane .folder-item .storage-title{gap:8px}
  #storagePane .folder-item .storage-title strong{font-size:15px;letter-spacing:-.015em}
  #storagePane .folder-item .storage-path{margin-top:4px;color:#77706e;font-size:10px;font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace}
  #storagePane .folder-item .storage-meta{margin-top:8px;font-size:11px;color:#928986}
  #storagePane .folder-item .storage-modes{margin-left:0;gap:4px}
  #storagePane .folder-item .storage-mode{padding:3px 6px;border-radius:999px;font-size:9px;font-weight:720}
  #storagePane .folder-item .storage-mode.local{background:#222126;color:#aaa8b0}
  #storagePane .folder-item .storage-mode.protected{background:#302427;color:#e0aaa4}
  #storagePane .folder-item .item-actions{width:auto;min-width:0;justify-content:flex-end}
  #storagePane .folder-item.browse-only-folder .item-actions{opacity:1}
  #storagePane .folder-item [data-protect-folder]{padding:7px 9px;border-radius:8px;background:#242124;color:#e4b1ab}
  #storagePane .folder-item [data-protect-folder]:hover{background:#30272a;color:#fff}
  #storagePane .folder-item .storage-open-folder{border-radius:7px}

  #storagePane .backup-item{padding:14px 4px}
  #storagePane .backup-item .storage-title strong{font-size:14px}
  #storagePane .backup-item .storage-path{font-size:10px;color:#746d6b}
  #storagePane .backup-item .storage-meta{font-size:10px}
  #storagePane #protectionDashboard{margin-top:-4px}
  #storagePane #protectionDashboard .section-head{min-height:42px}

  @media(max-width:700px){
    #storagePane{width:min(100% - 20px,980px);gap:26px;padding-top:8px}
    #storagePane .section-head{min-height:46px}
    .storage-add-button{height:34px;padding:0 10px}
    #storagePane .folder-item.has-folder-preview{grid-template-columns:124px minmax(0,1fr);gap:11px;align-items:start;min-height:126px}
    #storagePane .folder-item.has-folder-preview .storage-folder-samples{width:124px;height:102px;grid-row:1 / span 2}
    #storagePane .folder-item.has-folder-preview .item-actions{grid-column:2}
    #storagePane .folder-item .storage-title{align-items:center;flex-wrap:wrap}
    #storagePane .folder-item .storage-title strong{flex-basis:100%;font-size:13px}
    #storagePane .folder-item .item-state{margin-left:0;font-size:10px}
    #storagePane .folder-item .storage-path{font-size:8px;line-height:1.3}
    #storagePane .folder-item .storage-meta{font-size:9px;gap:4px}
    #storagePane .folder-item .item-actions{justify-content:flex-start}
  }
`;
document.head.append(style);

const cleanPath = value => String(value || '').replace(/[\\/]+$/, '');
const folderName = value => cleanPath(value).split(/[\\/]+/).filter(Boolean).at(-1) || cleanPath(value);

function replacePhrase(value) {
  return String(value || '')
    .replaceAll('already in Mochimono', 'already in Cloud')
    .replaceAll('Mochimono repaired', 'Cloud repaired')
    .replaceAll('Mochimono keeps another copy.', 'Cloud keeps another copy.')
    .replaceAll('Stop keeping Mochimono copy', 'Stop keeping Cloud copy')
    .replaceAll('Add Mochimono copy', '+ Cloud');
}

function ensureFolderPath(row, fullPath) {
  const copy = row.querySelector('.storage-copy');
  const title = copy?.querySelector('.storage-title');
  if (!copy || !title) return;
  let path = copy.querySelector(':scope > .storage-path');
  if (!path) {
    path = document.createElement('div');
    path.className = 'storage-path';
    title.after(path);
  }
  if (path.textContent !== fullPath) path.textContent = fullPath;
  path.title = fullPath;
}

function polishFolder(row) {
  const fullPath = String(row.dataset.folderPath || '');
  if (!fullPath) return;

  const title = row.querySelector('.storage-title strong');
  if (title) {
    const name = folderName(fullPath);
    if (title.textContent !== name) title.textContent = name;
    title.title = fullPath;
  }
  ensureFolderPath(row, fullPath);

  for (const badge of row.querySelectorAll('.storage-mode')) {
    const text = badge.textContent.trim();
    if (text === 'This PC') badge.textContent = 'Local';
    else if (text === 'Mochimono') badge.textContent = 'Cloud';
    badge.title = badge.textContent.trim() === 'Cloud' ? 'Cloud copy' : 'Files on this PC';
  }

  const cloud = row.querySelector('[data-protect-folder]');
  if (cloud) {
    if (cloud.textContent !== '+ Cloud') cloud.textContent = '+ Cloud';
    cloud.title = 'Keep a Cloud copy';
    cloud.setAttribute('aria-label', 'Keep a Cloud copy');
  }

  const remove = row.querySelector('[data-remove-folder]');
  if (remove) {
    const next = replacePhrase(remove.title);
    if (next !== remove.title) remove.title = next;
    const aria = replacePhrase(remove.getAttribute('aria-label'));
    if (aria) remove.setAttribute('aria-label', aria);
  }
}

function polishWording(root = storage) {
  if (!root) return;
  const exact = new Map([
    ['No protected folders', 'No folders'],
    ['Mochimono', 'Cloud'],
    ['Add Mochimono copy', '+ Cloud']
  ]);
  const selectors = [
    '.empty-state', '.storage-mode', '[data-protect-folder]',
    '.item-progress strong', '.item-progress span',
    '#protectionDashboard strong', '#protectionDashboard span', '#protectionDashboard button'
  ];
  for (const node of root.querySelectorAll(selectors.join(','))) {
    const current = node.textContent;
    const next = exact.get(current.trim()) || replacePhrase(current);
    if (next !== current) node.textContent = next;
  }
  for (const node of root.querySelectorAll('[title],[aria-label]')) {
    if (node.closest('.storage-folder-sample')) continue;
    for (const attr of ['title','aria-label']) {
      const current = node.getAttribute(attr);
      if (!current) continue;
      const next = replacePhrase(current);
      if (next !== current) node.setAttribute(attr, next);
    }
  }
}

let polishQueued = false;
function polish() {
  polishQueued = false;
  for (const row of folders?.querySelectorAll('[data-folder-path]') || []) polishFolder(row);
  polishWording(storage);
  for (const box of document.querySelectorAll('dialog')) polishWording(box);
}

function queuePolish() {
  if (polishQueued) return;
  polishQueued = true;
  queueMicrotask(polish);
}

if (storage) {
  new MutationObserver(queuePolish).observe(storage, { childList:true, subtree:true, characterData:true });
  new MutationObserver(records => {
    if (records.some(record => [...record.addedNodes].some(node => node instanceof HTMLDialogElement))) queuePolish();
  }).observe(document.body, { childList:true });
}

queuePolish();
