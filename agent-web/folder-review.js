const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const bytes = number => {
  let value = Number(number) || 0, unit = 0;
  const units = ['B','KB','MB','GB','TB'];
  while (value >= 1000 && unit < units.length-1) { value /= 1000; unit++; }
  return `${unit ? value.toFixed(1) : value} ${units[unit]}`;
};
export async function backupRequest(path, options = {}) {
  const response = await fetch(path, { cache:'no-store', ...options, headers:{'content-type':'application/json',...options.headers}, body:options.body ? JSON.stringify(options.body) : undefined });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}
export function sourcesChanged() {
  window.dispatchEvent(new CustomEvent('mochimono:sources-changed'));
  document.querySelector('#folders')?.dispatchEvent(new MouseEvent('click',{bubbles:true}));
}
export async function setFolderGoal(path, scope, goal) {
  const state = await backupRequest('/api/state');
  const source = state.settings?.folders?.find(folder => String(folder.path).replace(/[\\/]+$/,'').toLowerCase() === path.replace(/[\\/]+$/,'').toLowerCase());
  if (goal === 'browse') {
    if (source?.protected !== false && source) await backupRequest('/api/folders/browse',{method:'POST',body:{path,scope}});
    else await backupRequest('/api/browse-folders',{method:'POST',body:{path,scope}});
  } else if (source?.protected === false) {
    await backupRequest('/api/browse-folders',{method:'POST',body:{path,scope}});
    await backupRequest('/api/browse-folders/protect',{method:'POST',body:{path,level:goal}});
  } else await backupRequest('/api/folders',{method:'POST',body:{path,scope,level:goal}});
  sourcesChanged();
}

const dialog = document.createElement('dialog');
dialog.className = 'folder-review-dialog';
dialog.innerHTML = `<div class="dialog-head"><h3>Review folders</h3><button class="icon" data-review-close aria-label="Close">×</button></div>
  <p class="backup-note">New folders don’t upload until you start backup. Existing plans continue unchanged.</p>
  <div data-review-list></div><p class="backup-note" data-review-total></p>
  <div class="backup-error" role="status" data-review-error></div>
  <div class="dialog-actions"><button class="secondary" data-review-close>Cancel</button><div class="spacer"></div><button class="primary" data-review-start disabled>Apply</button></div>`;
document.body.append(dialog);
let items = [], generation = 0, saving = false;
const list = dialog.querySelector('[data-review-list]');
const start = dialog.querySelector('[data-review-start]');
const error = dialog.querySelector('[data-review-error]');

function totals() {
  let upload = 0, omitted = 0, backups = 0, unknown = false;
  for (const item of items) {
    if (!item.estimate || item.estimate.truncated || item.estimate.unreadable) unknown = true;
    const estimate = item.estimate;
    if (!estimate || item.goal === 'browse') continue;
    backups++;
    const media = (estimate.kinds.image.bytes || 0) + (estimate.kinds.video.bytes || 0);
    upload += item.scope === 'media' ? media : estimate.bytes;
    if (item.scope === 'media') omitted += estimate.files - estimate.kinds.image.files - estimate.kinds.video.files;
  }
  dialog.querySelector('[data-review-total]').textContent = backups
    ? `${unknown ? 'Upload estimate incomplete · measured' : 'Server upload: up to'} ${bytes(upload)} before exact deduplication.${omitted ? ` ${omitted.toLocaleString()} non-media files will not be backed up.` : ''}`
    : 'Browse only: no automatic file backup or upload.';
  start.textContent = saving ? 'Applying…' : backups ? 'Start backup' : 'Add for browsing';
  start.disabled = saving || items.some(item => !item.estimate && !item.error) || items.some(item => item.error && item.goal !== 'browse');
}
function renderItem(item) {
  const row = list.querySelector(`[data-review-index="${items.indexOf(item)}"]`);
  const detail = row.querySelector('[data-review-detail]');
  const estimate = item.estimate;
  detail.textContent = item.error || (!estimate ? 'Scanning locally…' : `${estimate.truncated ? 'At least ' : ''}${estimate.files.toLocaleString()} files · ${bytes(estimate.bytes)}${estimate.unreadable ? ` · ${estimate.unreadable} unreadable areas` : ''}${estimate.excluded ? ` · ${estimate.excluded} excluded paths` : ''}`);
  if (estimate) row.querySelector('[data-review-kinds]').textContent = [['image','Photos'],['video','Videos'],['document','Documents'],['other','Other']].map(([kind,label]) => `${label} ${estimate.kinds[kind].files.toLocaleString()}`).join(' · ');
  row.querySelector('[data-review-detail]').classList.toggle('backup-error', Boolean(item.error || estimate?.unreadable || estimate?.truncated));
  totals();
}
export async function reviewFolders(paths, { goal, scope } = {}) {
  if (saving) return;
  const mine = ++generation;
  error.textContent = '';
  list.innerHTML='<p class="backup-note">Checking folder settings…</p>';
  start.disabled=true;
  if(!dialog.open)dialog.showModal();
  let state, rules=[];
  const key=value=>String(value).replace(/[\\/]+$/,'').toLowerCase();
  const selectedPaths=new Set(paths.map(key));
  try {
    state=await backupRequest('/api/state');
    if(goal===undefined&&(state.settings?.folders || []).some(folder=>selectedPaths.has(key(folder.path))&&folder.protected!==false&&folder.importId&&!folder.protectionLevel)) rules=(await backupRequest('/api/protection/rules')).rules || [];
  }catch(failure){error.textContent=failure.message;return;}
  if(mine!==generation||!dialog.open)return;
  items = [...new Set(paths)].map(path => {
    const existing=state.settings?.folders?.find(folder=>key(folder.path)===key(path));
    let inherited=existing?.protected!==false&&existing ? existing.protectionLevel || rules.find(rule=>Number(rule.scopeId)===Number(existing.importId))?.level || 'normal' : 'browse';
    if(inherited==='critical')inherited='important';
    return {path,goal:goal ?? inherited,scope:scope ?? existing?.scope ?? 'all',wasProtected:Boolean(existing&&existing.protected!==false)};
  });
  list.innerHTML = items.map((item,index) => `<section class="folder-review-row" data-review-index="${index}"><strong title="${esc(item.path)}">${esc(item.path)}</strong>
    <p data-review-detail>Scanning locally…</p><small data-review-kinds></small>
    <div class="backup-fields"><label>Goal<select data-review-goal><option value="browse">Browse only · not backed up</option><option value="normal">Back up · 2 Originals</option><option value="important">Important · 3 Originals + off-site</option>${item.goal==='disposable'?'<option value="disposable">One copy · no redundancy</option>':''}</select></label>
    <label>Files to include<select data-review-scope><option value="all">All files</option><option value="media">Photos & videos only</option></select></label></div></section>`).join('');
  for (const [index,item] of items.entries()) {
    const row = list.children[index];
    row.querySelector('[data-review-goal]').value = item.goal;
    row.querySelector('[data-review-scope]').value = item.scope;
  }
  if (!dialog.open) dialog.showModal();
  totals();
  for (const item of items) {
    if (mine !== generation || !dialog.open) return;
    try { item.estimate = await backupRequest('/api/client/protection/estimate-folder',{method:'POST',body:{path:item.path}}); }
    catch (failure) { item.error = failure.message; }
    if (mine !== generation || !dialog.open) return;
    renderItem(item);
  }
}
list.addEventListener('change', event => {
  const row = event.target.closest('[data-review-index]');
  if (!row) return;
  const item = items[Number(row.dataset.reviewIndex)];
  item.goal = row.querySelector('[data-review-goal]').value;
  item.scope = row.querySelector('[data-review-scope]').value;
  totals();
});
dialog.querySelectorAll('[data-review-close]').forEach(button => button.onclick = () => { if (!saving) dialog.close(); });
dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
dialog.addEventListener('close', () => { generation++; });
start.onclick = async () => {
  if (saving || start.disabled) return;
  const stopped=items.filter(item=>item.wasProtected&&item.goal==='browse'&&!item.applied);
  if(stopped.length&&!confirm(`Stop backing up ${stopped.length} ${stopped.length===1?'folder':'folders'}? Existing managed copies are kept for review. Your original files are unchanged.`))return;
  const incomplete = items.some(item => item.goal !== 'browse' && (item.estimate?.unreadable || item.estimate?.truncated));
  if (incomplete && !confirm('The scan is incomplete. Upload/storage may exceed the measured amount, and backup may remain incomplete until selected files can be read. Start backup?')) return;
  saving = true;
  dialog.querySelectorAll('select').forEach(select => select.disabled = true);
  totals();
  try {
    for (const item of items) { if (!item.applied) { await setFolderGoal(item.path,item.scope,item.goal); item.applied = true; } }
    document.querySelector('#filesFrame')?.contentWindow?.mochimonoClientBridge?.followLocalIndex?.(items.map(item => item.path));
    dialog.close();
  } catch (failure) { error.textContent = failure.message; }
  finally { saving = false; dialog.querySelectorAll('select').forEach(select => select.disabled = false); totals(); sourcesChanged(); }
};
