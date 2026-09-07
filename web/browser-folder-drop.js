import './browser-folder-sync.js';

let pendingHandles = Promise.resolve([]);
let currentHandles = [];
let button = null;
let choiceObserver = null;

async function directoryHandles(dataTransfer) {
  // getAsFileSystemHandle() must be invoked while the drop event still owns the
  // protected DataTransfer store. Start every request synchronously, then await.
  const requests = [];
  for (const item of dataTransfer?.items || []) {
    if (item.kind !== 'file' || !item.getAsFileSystemHandle) continue;
    try { requests.push(Promise.resolve(item.getAsFileSystemHandle()).catch(() => null)); }
    catch {}
  }
  const handles = await Promise.all(requests);
  return handles.filter(handle => handle?.kind === 'directory');
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

function removeButton(choice = document.querySelector('.client-drop-choice')) {
  button?.remove();
  button = null;
  choice?.querySelector('[data-drop-copy]')?.classList.add('primary');
}

async function decorateChoice(choice) {
  currentHandles = await pendingHandles.catch(() => []);
  removeButton(choice);
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
    removeButton(choice);
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

function watchChoice(choice) {
  choiceObserver?.disconnect();
  choiceObserver = new MutationObserver(() => {
    if (choice.hidden) removeButton(choice);
    else queueMicrotask(() => decorateChoice(choice));
  });
  choiceObserver.observe(choice, { attributes:true, attributeFilter:['hidden'] });
  if (!choice.hidden) queueMicrotask(() => decorateChoice(choice));
}

const existing = document.querySelector('.client-drop-choice');
if (existing) watchChoice(existing);
else {
  const finder = new MutationObserver(() => {
    const choice = document.querySelector('.client-drop-choice');
    if (!choice) return;
    finder.disconnect();
    watchChoice(choice);
  });
  finder.observe(document.body, { childList:true });
}
