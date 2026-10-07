import { backupRequest, reviewFolders, setFolderGoal, sourcesChanged } from './folder-review.js';

const folders = document.querySelector('#folders');
const pathKey = value => String(value || '').replace(/[\\/]+$/,'').toLowerCase();
const labels = {browse:'Browse only',normal:'Back up',important:'Important',critical:'Important',disposable:'One copy',checking:'Goal unavailable'};
let native = new Map(), rules = new Map(), rulesReady = false, refreshing = false, timer = 0, current = null, saving = false;
const dialog = document.createElement('dialog');
dialog.className = 'small-dialog source-settings-dialog';
dialog.innerHTML = `<div class="dialog-head"><h3 data-source-title>Folder</h3><button class="icon" data-source-close aria-label="Close">×</button></div>
  <p class="source-settings-path" data-source-path></p>
  <div class="backup-fields"><label>Backup goal<select data-source-goal aria-label="Backup goal"></select></label>
  <label data-source-selection-label>Include<select data-source-selection aria-label="Files included"><option value="all">All files</option><option value="media">Photos & videos</option></select></label></div>
  <p class="backup-note" data-source-goal-detail></p><p class="backup-error" data-source-warning></p><p class="backup-error" role="status" data-source-error></p>
  <div class="dialog-actions"><button class="secondary" data-source-refresh>Scan now</button><div class="spacer"></div><button class="primary" data-source-save>Save</button></div>`;
document.body.append(dialog);
function toast(text) {
  const node = document.querySelector('#toast');
  if (!node) return;
  node.textContent = text; node.classList.add('show'); clearTimeout(node.timer);
  node.timer = setTimeout(() => node.classList.remove('show'),3500);
}
function decorate(row, source) {
  const browser = Boolean(row.dataset.browserFolder);
  const enabled = browser ? row.dataset.sourceCloud === '1' : source.protected !== false;
  const scope = browser ? row.dataset.sourceScope || 'all' : source.scope || 'all';
  const goal = enabled ? rules.get(Number(source.importId)) || source.protectionLevel || 'normal' : 'browse';
  const known = browser || !enabled || source.protectionLevel || !source.importId || rulesReady;
  row.dataset.sourceCloud = enabled ? '1' : '0'; row.dataset.sourceScope = scope;
  row.dataset.sourceGoal = known ? goal : 'checking';
  let node = row.querySelector('.source-controls');
  if (!node) {
    node = document.createElement('div'); node.className = 'source-controls';
    node.innerHTML = '<button type="button" class="source-goal-button" data-source-settings><span data-source-goal-name></span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg></button><span class="source-selection-badge" hidden>Photos & videos</span>';
    row.querySelector('.storage-copy')?.append(node);
  }
  node.querySelector('[data-source-goal-name]').textContent = labels[row.dataset.sourceGoal] || 'Back up';
  node.querySelector('[data-source-settings]').title = 'Folder settings';
  node.querySelector('.source-selection-badge').hidden = scope !== 'media';
  let health = row.querySelector('[data-folder-status]');
  if (browser && !health) { health = document.createElement('span'); health.dataset.folderStatus = ''; row.querySelector('.storage-title')?.append(health); }
  if (browser) {
    health.className = 'item-state warning';
    health.textContent = enabled ? 'Check coverage' : 'Not backed up';
    health.title = row.dataset.sourceHealth === 'warn' ? 'Folder permission required' : row.dataset.sourceHealth === 'bad' ? 'Folder scan failed' : '';
  }
}
async function refresh() {
  clearTimeout(timer);
  if (refreshing || !folders) return;
  refreshing = true;
  try {
    const state = await backupRequest('/api/state');
    native = new Map((state.settings?.folders || []).map(source => [pathKey(source.path),source]));
    for (const row of folders.querySelectorAll(':scope > .folder-item')) {
      const source = native.get(pathKey(row.dataset.folderPath));
      if (source || row.dataset.browserFolder) decorate(row,source || {});
    }
  } catch (failure) { console.warn('Folder controls:',failure.message); }
  finally { refreshing = false; }
}
function schedule() { clearTimeout(timer); timer = setTimeout(refresh,50); }
function updateEditor() {
  const goal = dialog.querySelector('[data-source-goal]').value;
  const scope = dialog.querySelector('[data-source-selection]').value;
  dialog.querySelector('[data-source-goal-detail]').textContent = {browse:'No automatic backup',normal:'2 Originals · independent storage',important:'3 Originals · off-site',disposable:'1 Original · no redundancy',checking:'Backup goal could not be checked'}[goal] || '';
  dialog.querySelector('[data-source-warning]').textContent = goal !== 'browse' && scope === 'media' ? 'Other files excluded' : '';
  dialog.querySelector('[data-source-selection-label]').firstChild.textContent = goal === 'browse' ? 'Library includes' : 'Backup includes';
  dialog.querySelector('[data-source-save]').textContent = current?.enabled === false && goal !== 'browse' ? 'Start backup' : 'Save';
}
function openSettings(row) {
  const goal = row.dataset.sourceGoal || 'checking';
  current = {path:row.dataset.folderPath,browserId:row.dataset.browserFolder,enabled:row.dataset.sourceCloud==='1',scope:row.dataset.sourceScope || 'all'};
  dialog.querySelector('[data-source-title]').textContent = row.querySelector('.storage-path-name')?.textContent.trim() || row.querySelector('.storage-title strong')?.textContent.trim() || 'Folder';
  dialog.querySelector('[data-source-path]').textContent = row.dataset.folderPath || row.querySelector('.storage-title strong')?.title || '';
  const select = dialog.querySelector('[data-source-goal]');
  select.replaceChildren(...['browse','normal',...(!current.browserId?['important']:[]),...(goal==='disposable'?['disposable']:[]),...(goal==='checking'?['checking']:[])].map(value=>new Option(labels[value],value)));
  select.value = goal === 'critical' ? 'important' : goal;
  dialog.querySelector('[data-source-selection]').value = current.scope;
  dialog.querySelectorAll('select,[data-source-save]').forEach(node=>node.disabled=goal==='checking');
  dialog.querySelector('[data-source-error]').textContent = '';
  dialog.querySelector('[data-source-refresh]').textContent = current.enabled ? 'Back up now' : 'Scan now';
  updateEditor();dialog.showModal();
}
folders?.addEventListener('click',event=>{
  const button=event.target.closest('[data-source-settings]');
  if(button)openSettings(button.closest('.folder-item'));
});
dialog.querySelector('[data-source-close]').onclick=()=>{if(!saving)dialog.close();};
dialog.addEventListener('cancel',event=>{if(saving)event.preventDefault();});
dialog.addEventListener('change',updateEditor);
dialog.querySelector('[data-source-save]').onclick=async()=>{
  if(saving||!current)return;
  const {path,browserId,enabled,scope:oldScope}=current;
  const goal=dialog.querySelector('[data-source-goal]').value,scope=dialog.querySelector('[data-source-selection]').value;
  saving=true;dialog.querySelectorAll('button,select').forEach(node=>node.disabled=true);
  try{
    if(!browserId&&!enabled&&goal!=='browse'){dialog.close();await reviewFolders([path],{goal,scope});return;}
    if(goal==='browse'&&enabled&&!confirm('Stop backup? Managed copies are kept. Source files are unchanged.'))return;
    if(scope==='media'&&oldScope!=='media'&&enabled&&!confirm('Exclude documents and other files? Existing copies are kept.'))return;
    if(browserId){
      const shell=window.mochimonoBrowserFolderShell;
      if(!shell)throw new Error('Folder is still loading');
      if(!enabled&&goal!=='browse'&&!confirm(`Start backing up ${scope==='all'?'all files':'photos and videos'}?`))return;
      if(scope!==oldScope)await shell.setScope(browserId,scope);
      if((goal!=='browse')!==enabled)await shell.setCloud(browserId,goal!=='browse');
    }else await setFolderGoal(path,scope,goal);
    dialog.close();sourcesChanged();
  }catch(failure){dialog.querySelector('[data-source-error]').textContent=failure.message;}
  finally{saving=false;dialog.querySelectorAll('button,select').forEach(node=>node.disabled=false);schedule();}
};
dialog.querySelector('[data-source-refresh]').onclick=async event=>{
  event.target.disabled=true;
  try{
    if(current.browserId)await window.mochimonoBrowserFolderShell.sync(current.browserId);
    else await backupRequest('/api/folders/sync',{method:'POST',body:{path:current.path}});
    dialog.close();sourcesChanged();
  }catch(failure){toast(failure.message);}
  finally{event.target.disabled=false;}
};
if(folders)new MutationObserver(schedule).observe(folders,{childList:true});
window.addEventListener('mochimono:sources-changed',schedule);
window.addEventListener('mochimono:backup-state',event=>{
  rules=new Map((event.detail.rules || []).map(rule=>[Number(rule.scopeId),rule.level]));rulesReady=Boolean(event.detail.summary);schedule();
});
window.mochimonoSourceControls={refresh:schedule};
schedule();
