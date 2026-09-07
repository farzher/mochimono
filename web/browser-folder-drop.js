import './browser-folder-sync.js';

let pendingHandles = Promise.resolve([]);
let currentHandles = [];
let button = null;

async function directoryHandles(dataTransfer) {
  const result = [];
  for (const item of dataTransfer?.items || []) {
    if (item.kind !== 'file' || !item.getAsFileSystemHandle) continue;
    try {
      const handle = await item.getAsFileSystemHandle();
      if (handle?.kind === 'directory') result.push(handle);
    } catch {}
  }
  return result;
}

function toast(text) {
  let node = document.querySelector('.browser-folder-drop-toast');
  if (!node) {
    node = document.createElement('div');
    node.className = 'browser-folder-drop-toast';
    Object.assign(node.style, {
      position:'fixed', right:'18px', bottom:'18px', zIndex:'120', padding:'10px 12px',
      border:'1px solid #302b30', borderRadius:'10px', background:'#171518', color:'#e7dfdc',
      font:'11px Inter,system-ui,sans-serif', boxShadow:'0 16px 50px rgba(0,0,0,.45)'
    });
    document.body.append(node);
  }
  node.textContent = text;
  node.hidden = false;
  clearTimeout(node.timer);
  node.timer = setTimeout(() => { node.hidden = true; }, 3500);
}

function removeButton() {
  button?.remove();
  button = null;
}

async function decorateChoice(choice) {
  currentHandles = await pendingHandles.catch(() => []);
  removeButton();
  if (!currentHandles.length || choice.hidden) return;
  const actions = choice.querySelector('.client-drop-actions');
  if (!actions) return;

  button = document.createElement('button');
  button.type = 'button';
  button.className = 'client-drop-action primary';
  button.dataset.dropBrowserSync = '';
  button.innerHTML = '<b>Sync folder</b><span>Photos and videos · remembers browser access · syncs while Mochimono is open</span>';
  actions.prepend(button);

  const existingPrimary = actions.querySelector('[data-drop-copy]');
  existingPrimary?.classList.remove('primary');

  const note = choice.querySelector('[data-drop-note]');
  if (note) note.textContent = 'The browser hides the full disk path. You can set the real path later in Storage if you want Mochimono to remember where this folder physically belongs.';

  button.onclick = async () => {
    const handles = [...currentHandles];
    choice.querySelector('.client-drop-choice-close')?.click();
    removeButton();
    if (!handles.length) return;
    toast(handles.length === 1 ? `Syncing ${handles[0].name}…` : `Syncing ${handles.length} folders…`);
    try {
      await window.mochimonoBrowserFolders.addHandles(handles, 'media', { sync:true });
      toast(handles.length === 1 ? `${handles[0].name} synced` : `${handles.length} folders synced`);
      await window.mochimonoLibrary?.refresh?.();
    } catch (error) {
      toast(error.message || 'Could not sync folder');
    }
  };
}

document.addEventListener('drop', event => {
  pendingHandles = directoryHandles(event.dataTransfer);
}, true);

const observer = new MutationObserver(records => {
  for (const record of records) {
    const target = record.target;
    const choice = target?.matches?.('.client-drop-choice') ? target : document.querySelector('.client-drop-choice');
    if (!choice || choice.hidden) continue;
    queueMicrotask(() => decorateChoice(choice));
    return;
  }
  if (document.querySelector('.client-drop-choice')?.hidden) removeButton();
});
observer.observe(document.documentElement, { childList:true, subtree:true, attributes:true, attributeFilter:['hidden'] });
