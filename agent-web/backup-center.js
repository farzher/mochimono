import { backupRequest, sourcesChanged } from './folder-review.js';

const pane = document.querySelector('#storagePane');
const section = document.createElement('section');
section.className = 'backup-overview';section.id = 'backupCenter';
const gear='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 3-.6 2.3-2 .9-2.1-.7-2 3.5 1.6 1.6v2.3L2.3 15l2 3.5 2.1-.7 2 .9L9 21h4l.6-2.3 2-.9 2.1.7 2-3.5-1.6-1.6v-2.3l1.6-1.6-2-3.5-2.1.7-2-.9L13 3Z"/><circle cx="11" cy="12" r="3"/></svg>';
section.innerHTML = `<div data-backup-health aria-live="polite">Checking…</div><div class="backup-head-actions"><button class="backup-settings-button" data-backup-settings aria-label="Backup settings" title="Backup settings">${gear}</button><button class="primary" data-backup-now>Back up now</button></div><div class="backup-error" role="status" data-backup-error></div><datalist id="backupPlaceNames"></datalist>`;
pane?.prepend(section);
const settingsDialog=document.createElement('dialog');settingsDialog.className='small-dialog backup-settings-dialog';
settingsDialog.innerHTML='<div class="dialog-head"><h3>Backup settings</h3><button class="icon" data-settings-close aria-label="Close">×</button></div><div class="backup-settings-row"><label>Automatic backup<select data-backup-background><option value="auto">On</option><option value="paused">Paused</option></select></label><label>This PC’s place<input data-backup-place list="backupPlaceNames" placeholder="e.g. Home" maxlength="120"></label></div><p class="backup-error" data-settings-error role="status"></p><div class="dialog-actions"><div class="spacer"></div><button class="primary" data-save-settings>Save</button></div>';
const detailsDialog=document.createElement('dialog');detailsDialog.className='small-dialog backup-details-dialog';
detailsDialog.innerHTML='<div class="dialog-head"><h3>Backup status</h3><button class="icon" data-details-close aria-label="Close">×</button></div><div data-backup-details></div>';
document.body.append(settingsDialog,detailsDialog);
const control=(path,options)=>backupRequest(`/api/client/protection/${path}`,options);
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const number=value=>(Number(value)||0).toLocaleString();
let model,stats=[],localState,busy=false,timer,runningManual=false;
function viewFiles(mode){
  window.mochimonoNavigationShell?.open({});let attempts=0;
  const open=()=>{
    const child=document.querySelector('#filesFrame')?.contentWindow;
    if(child?.mochimonoLibrary?.showProtection){child.mochimonoLibrary.showProtection(mode);child.focus();}
    else if(++attempts<40)setTimeout(open,75);
  };open();
}
function statusIcon(tone){
  return tone==='good'?'<path d="m5 12 4 4 10-10"/>':tone==='needs'?'<path d="M12 7v6m0 4h.01"/><circle cx="12" cy="12" r="9"/>':'<path d="M4 8h6l2 2h8v9H4Z"/>';
}
function render(){
  const summary=model.summary,health=section.querySelector('[data-backup-health]');
  const protectedFolders=(localState.settings?.folders || []).filter(folder=>folder.protected!==false);
  const browseFolders=(localState.settings?.folders || []).filter(folder=>folder.protected===false).length+document.querySelectorAll('#folders [data-browser-folder][data-source-cloud="0"]').length;
  const key=path=>String(path).replace(/[\\/]+$/,'').toLowerCase();
  const unknown=protectedFolders.filter(folder=>{
    const stat=stats.find(item=>key(item.path)===key(folder.path));
    return !stat||!stat.available||!stat.lastSynced||stat.lastError||stat.pending;
  });
  const browserRoots=[...document.querySelectorAll('#folders [data-browser-folder][data-source-cloud="1"]')];
  for(const row of browserRoots)if(row.dataset.sourceChecked!=='1'||row.dataset.sourceHealth!=='ok'||row.matches('.source-busy,.source-queued'))unknown.push({path:row.querySelector('.storage-title strong')?.textContent || 'Browser folder'});
  const places=new Map();
  for(const location of model.locations || [])if(location.place)places.set(location.place.trim().toLowerCase(),location.place);
  section.querySelector('#backupPlaceNames').innerHTML=[...places.values()].sort().map(place=>`<option value="${esc(place)}"></option>`).join('');
  const active=model.job?.status==='running'?model.job:null;
  const job=active&&(['protection','backup'].includes(active.type)||protectedFolders.some(folder=>key(folder.path)===key(active.progress?.path || '')))?active:null;
  section.querySelector('[data-backup-now]').disabled=runningManual||Boolean(job)||(!summary?.files&&!protectedFolders.length&&!browserRoots.length);
  section.querySelector('[data-backup-now]').textContent=job||runningManual?'Working…':'Back up now';
  if(!summary){health.innerHTML='<span class="backup-status-unavailable">Coverage unavailable</span>';return;}
  const remaining=Math.max(0,Number(summary.files)-Number(summary.protectedFiles));
  const oneCopy=Number(summary.levels?.disposable?.files)||0,singleMet=Number(summary.levels?.disposable?.protectedFiles)||0;
  const backedUp=Number(summary.protectedFiles)-singleMet,totalBackups=Number(summary.files)-oneCopy;
  const title=unknown.length?'Needs checking':!summary.files?'No backup yet':remaining?`${number(remaining)} need backup`:oneCopy?'Goals met':'Backed up';
  const tone=unknown.length||remaining||oneCopy?'needs':summary.files?'good':'empty';
  const times=protectedFolders.map(folder=>stats.find(item=>key(item.path)===key(folder.path))?.lastSynced).filter(Boolean).map(value=>new Date(value).getTime());
  const checked=times.length?new Date(Math.min(...times)).toLocaleString():'Not yet checked';
  const chips=[];
  const chip=(label,attributes='',warning=false)=>`<button class="backup-status-chip${warning?' warning':''}" ${attributes}>${label}</button>`;
  if(unknown.length)chips.push(chip(`${number(unknown.length)} to check`,'data-backup-status-details',true));
  if(browseFolders)chips.push(chip(`${number(browseFolders)} browse only`,'data-backup-status-details'));
  if(summary.ignoredSourceFiles)chips.push(chip(`${number(summary.ignoredSourceFiles)} excluded`,'data-backup-status-details'));
  if(oneCopy)chips.push(chip(`${number(oneCopy)} one copy`,'data-backup-status-details',true));
  if(summary.unlinkedFiles)chips.push(chip(`${number(summary.unlinkedFiles)} to review`,'data-view="unlinked"',true));
  const unsavedKeys=(model.locations || []).filter(location=>location.encrypted&&location.recoveryReady!==true);
  if(unsavedKeys.length)chips.push(chip(`${number(unsavedKeys.length)} keys to save`,'data-backup-status-details',true));
  if(model.config.background==='paused')chips.push(chip('Paused','data-backup-settings',true));
  const ratio=totalBackups?`${number(backedUp)} / ${number(totalBackups)} files`:'';
  const percent=totalBackups?Math.round(backedUp/totalBackups*100):0;
  health.innerHTML=`<div class="backup-status-strip ${tone}"><button class="backup-status-main" ${summary.files?`data-view="${remaining?'needs-backup':'managed'}"`:'data-backup-status-details'} title="Original backup coverage · oldest check: ${esc(checked)}"><span class="backup-status-icon"><svg viewBox="0 0 24 24" aria-hidden="true">${statusIcon(tone)}</svg></span><strong>${esc(title)}</strong>${ratio?`<span class="backup-status-count">${ratio}</span>`:''}</button>${totalBackups?`<span class="backup-coverage-track" aria-hidden="true"><i style="width:${percent}%"></i></span>`:''}<div class="backup-status-chips">${chips.join('')}</div>${job?`<span class="backup-job-status">${esc(job.progress?.phase || 'Backing up…')}</span>`:''}</div>`;
  const detailRows=[];
  if(summary.files)detailRows.push(`<p class="backup-note">${number(backedUp)} of ${number(totalBackups)} files have their requested Original backups.</p>`);
  if(unknown.length)detailRows.push('<h4>Needs checking</h4>'+unknown.map(folder=>`<p class="backup-detail-path">${esc(folder.path)}</p>`).join(''));
  if(browseFolders)detailRows.push(`<p>${number(browseFolders)} browse-only folders · not backed up</p>`);
  if(summary.ignoredSourceFiles)detailRows.push(`<p>${number(summary.ignoredSourceFiles)} trashed or ignored source files · excluded</p>`);
  if(oneCopy)detailRows.push(`<p class="backup-error">${number(oneCopy)} files use One copy · no redundancy</p>`);
  if(unsavedKeys.length)detailRows.push('<h4>Save recovery keys outside this PC</h4>'+unsavedKeys.map(location=>`<p>${esc(location.name)}</p>`).join(''));
  if(summary.remoteOnlyFiles)detailRows.push(`<p>${number(summary.remoteOnlyFiles)} stored without an active source</p>`);
  detailRows.push(`<p class="backup-note">Oldest folder check: ${esc(checked)}</p>`);
  detailsDialog.querySelector('[data-backup-details]').innerHTML=detailRows.join('');
  window.dispatchEvent(new CustomEvent('mochimono:protection-summary',{detail:summary}));
  window.dispatchEvent(new CustomEvent('mochimono:backup-state',{detail:model}));
}
async function refresh(){
  clearTimeout(timer);
  if(busy||document.hidden||pane?.hidden){timer=setTimeout(refresh,5000);return;}
  busy=true;
  try{
    [model,localState]=await Promise.all([control('state'),backupRequest('/api/state')]);
    stats=(await backupRequest('/api/folder-stats')).folders || [];render();
  }catch(failure){section.querySelector('[data-backup-health]').innerHTML=`<span class="backup-status-unavailable" title="${esc(failure.message)}">Coverage unavailable</span>`;}
  finally{busy=false;timer=setTimeout(refresh,10000);}
}
async function action(work){
  const error=section.querySelector('[data-backup-error]');error.textContent='';
  try{await work();sourcesChanged();await refresh();}catch(failure){error.textContent=failure.message;}
}
function openSettings(){
  if(!model)return;
  settingsDialog.querySelector('[data-backup-background]').value=model.config.background;
  settingsDialog.querySelector('[data-backup-place]').value=model.config.place || '';
  settingsDialog.querySelector('[data-settings-error]').textContent='';settingsDialog.showModal();
}
section.addEventListener('click',event=>{
  const mode=event.target.closest('[data-view]')?.dataset.view;
  if(mode)viewFiles(mode);
  if(event.target.closest('[data-backup-settings]'))openSettings();
  if(event.target.closest('[data-backup-status-details]'))detailsDialog.showModal();
});
settingsDialog.querySelector('[data-settings-close]').onclick=()=>settingsDialog.close();
detailsDialog.querySelector('[data-details-close]').onclick=()=>detailsDialog.close();
settingsDialog.querySelector('[data-save-settings]').onclick=async event=>{
  const button=event.target;button.disabled=true;
  try{
    const mode=settingsDialog.querySelector('[data-backup-background]').value;
    const body={background:mode},place=settingsDialog.querySelector('[data-backup-place]').value;
    if(place!==(model.config.place || ''))body.place=place;
    await control('settings',{method:'POST',body});
    window.dispatchEvent(new CustomEvent('mochimono:backup-mode-changed',{detail:mode}));
    settingsDialog.close();sourcesChanged();await refresh();
  }catch(failure){settingsDialog.querySelector('[data-settings-error]').textContent=failure.message;}
  finally{button.disabled=false;}
};
section.querySelector('[data-backup-now]').onclick=async event=>{
  event.target.disabled=true;runningManual=true;
  await action(async()=>{await window.mochimonoBrowserFolders?.syncAll?.();await control('run',{method:'POST',body:{}});});
  runningManual=false;await refresh();
};
document.querySelector('#clientProtection')?.remove();
window.addEventListener('mochimono:protection-changed',refresh);
window.addEventListener('mochimono:sources-changed',refresh);
window.addEventListener('focus',refresh);
document.addEventListener('visibilitychange',refresh);
if(pane)new MutationObserver(refresh).observe(pane,{attributes:true,attributeFilter:['hidden']});
refresh();
