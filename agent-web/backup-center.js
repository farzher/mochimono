const CONTROL = 'http://127.0.0.1:8645';
const storagePane = document.querySelector('#storagePane');
const sourceSection = document.querySelector('.storage-folders-section');

if (storagePane && sourceSection) {
  const PLANS = {
    disposable:{ name:'One copy', short:'1×' },
    normal:{ name:'Standard', short:'2×' },
    important:{ name:'Important', short:'3× + remote' },
    critical:{ name:'Critical', short:'3 devices' }
  };
  const PLAN_ORDER = ['disposable','normal','important','critical'];
  let model = null;
  let dialog = null;
  let timer = 0;
  let busy = false;

  const style = document.createElement('style');
  style.textContent = `
    .backup-center{margin-top:20px;padding-top:27px;border-top:1px solid #211e21}
    .backup-center-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
    .backup-center-head h2{margin:0;color:#eee6e2;font-size:19px;font-weight:760;letter-spacing:-.025em}
    .backup-center-manage{border:0;background:transparent;color:#9d9490;font-size:12px;font-weight:700;padding:6px 2px}.backup-center-manage:hover{color:#eee6e2}
    .backup-health{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px;align-items:center;padding:15px 16px;border:1px solid #2b282b;border-radius:15px;background:#121013}
    .backup-health-copy{min-width:0}.backup-health-title{display:flex;align-items:center;gap:9px;color:#eee6e2;font-size:17px;font-weight:760;letter-spacing:-.02em}.backup-health-dot{width:9px;height:9px;border-radius:50%;background:#7fbe90;box-shadow:0 0 0 3px rgba(127,190,144,.08)}.backup-health.needs .backup-health-dot{background:#d8a36c}.backup-health.empty .backup-health-dot{background:#676164;box-shadow:none}
    .backup-health-sub{margin-top:5px;color:#918985;font-size:11px;font-variant-numeric:tabular-nums}.backup-health-sub:empty{display:none}
    .backup-health-actions{display:flex;align-items:center;gap:7px}.backup-health-actions button{white-space:nowrap}
    .backup-progress{height:4px;margin-top:10px;overflow:hidden;border-radius:99px;background:#292529}.backup-progress i{display:block;height:100%;border-radius:inherit;background:#83bb91;transition:width .2s ease}.backup-health.needs .backup-progress i{background:#cfa06f}.backup-health.empty .backup-progress{display:none}
    .backup-job{margin-top:8px;padding:8px 10px;border:1px solid #282429;border-radius:9px;background:#0f0e10;color:#9b928f;font-size:10px}.backup-job strong{color:#d8cfcb}
    .backup-plans{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;margin-top:8px}.backup-plan{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0;padding:8px 9px;border:1px solid #272428;border-radius:9px;background:#100f11}.backup-plan strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#cfc6c2;font-size:10px}.backup-plan b{color:#aaa19d;font-size:10px;font-weight:730;font-variant-numeric:tabular-nums}
    .backup-center-dialog{width:min(780px,calc(100vw - 28px));max-height:min(820px,calc(100dvh - 28px));overflow:auto}.backup-center-dialog .dialog-head{position:sticky;top:0;z-index:4;background:#151315}
    .backup-settings{display:grid;gap:20px}.backup-settings-section{display:grid;gap:7px}.backup-settings-section h4{margin:0;color:#dcd3cf;font-size:12px}
    .backup-plan-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}.backup-plan-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 10px;border:1px solid #292529;border-radius:9px;background:#111012}.backup-plan-row strong{color:#d2c9c5;font-size:10px}.backup-plan-row b{color:#8d8581;font-size:10px;font-weight:680}
    .backup-source-list,.backup-destination-list{display:grid;gap:6px}.backup-source-row,.backup-destination-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center;padding:9px 10px;border:1px solid #292529;border-radius:9px;background:#111012}.backup-row-copy{min-width:0}.backup-row-copy strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#d6cdca;font-size:11px}.backup-row-copy small{display:block;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#77706e;font-size:9px}.backup-source-row select,.backup-destination-row select,.backup-background select{width:auto;min-width:118px;padding:6px 8px;font-size:10px}
    .backup-destination-controls{display:flex;align-items:center;justify-content:flex-end;gap:5px;flex-wrap:wrap}.backup-destination-controls label{display:flex;align-items:center;gap:4px;color:#817976;font-size:9px}.backup-destination-controls select{min-width:108px}.backup-rely{border:0;border-radius:6px;background:#242125;color:#c3b9b5;font-size:9px;font-weight:700;padding:6px 7px}.backup-rely.off{background:transparent;color:#726a68}
    .backup-background{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 10px;border:1px solid #292529;border-radius:9px;background:#111012}.backup-background strong{color:#d6cdca;font-size:11px}
    .backup-empty{padding:8px 2px;color:#807875;font-size:10px}
    @media(max-width:760px){.backup-health{grid-template-columns:1fr}.backup-plans{grid-template-columns:repeat(2,minmax(0,1fr))}.backup-plan-list{grid-template-columns:1fr}.backup-source-row,.backup-destination-row{grid-template-columns:1fr}.backup-destination-controls{justify-content:flex-start}}
  `;
  document.head.append(style);

  const section = document.createElement('section');
  section.id = 'backupCenter';
  section.className = 'backup-center';
  section.innerHTML = '<div class="backup-center-head"><h2>Backup</h2><button class="backup-center-manage" type="button" data-backup-manage>Manage</button></div><div data-backup-body></div>';

  function placeSection() {
    const storage = document.querySelector('.managed-storage-section');
    if (storage) {
      if (storage.previousElementSibling !== section) storage.before(section);
    } else if (sourceSection.nextElementSibling !== section) sourceSection.after(section);
  }
  placeSection();

  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[char]));
  const baseName = value => String(value || '').replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).at(-1) || String(value || '');

  function bytes(number) {
    const units=['B','KB','MB','GB','TB','PB'];
    let value=Math.max(0,Number(number)||0),unit=0;
    while(value>=1000&&unit<units.length-1){value/=1000;unit++;}
    return `${value<10&&unit?value.toFixed(1):Math.round(value)} ${units[unit]}`;
  }

  function age(value) {
    const time=new Date(value||0).getTime();if(!time)return '';
    const s=Math.max(0,Math.floor((Date.now()-time)/1000));if(s<60)return 'now';
    const m=Math.floor(s/60);if(m<60)return `${m}m`;
    const h=Math.floor(m/60);if(h<48)return `${h}h`;
    return `${Math.floor(h/24)}d`;
  }

  async function request(base,path,options={}) {
    const response=await fetch(`${base}${path}`,{
      cache:'no-store',...options,
      headers:{'content-type':'application/json',...(options.headers||{})},
      body:options.body&&typeof options.body!=='string'?JSON.stringify(options.body):options.body
    });
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(data.error||response.statusText);
    return data;
  }
  const control=(path,options)=>request(CONTROL,path,options);
  const server=(path,options)=>request('',path,options);

  function toast(text) {
    const node=document.querySelector('#toast');if(!node)return;
    node.textContent=text;node.classList.add('show');clearTimeout(node.timer);
    node.timer=setTimeout(()=>node.classList.remove('show'),2400);
  }

  function planCount(level) {
    return Number(model?.state?.summary?.levels?.[level]?.files)||0;
  }

  function renderMain() {
    const body=section.querySelector('[data-backup-body]');
    const summary=model?.state?.summary;
    if(!summary){body.innerHTML='<div class="backup-empty">Unavailable</div>';return;}

    const total=Number(summary.files)||0;
    const protectedFiles=Number(summary.protectedFiles)||0;
    const needs=Number(summary.needsProtection)||0;
    const percent=total?Math.round(protectedFiles/total*100):0;
    const totalBytes=PLAN_ORDER.reduce((sum,level)=>sum+(Number(summary.levels?.[level]?.bytes)||0),0);
    const job=model.state.job?.status==='running'&&model.state.job?.type==='protection'?model.state.job:null;
    const progress=job?.progress||{};
    const title=!total?'No protected files':needs?`${needs.toLocaleString()} need protection`:'Protected';
    const sub=!total?'':`${protectedFiles.toLocaleString()} / ${total.toLocaleString()}${totalBytes?` · ${bytes(totalBytes)}`:''}`;
    const stateClass=!total?'empty':needs?'needs':'';

    body.innerHTML=`
      <div class="backup-health ${stateClass}">
        <div class="backup-health-copy">
          <div class="backup-health-title"><i class="backup-health-dot"></i>${esc(title)}</div>
          <div class="backup-health-sub">${esc(sub)}</div>
          <div class="backup-progress"><i style="width:${Math.max(0,Math.min(100,percent))}%"></i></div>
        </div>
        <div class="backup-health-actions"><button class="secondary" type="button" data-protect-now ${job||!total?'disabled':''}>${job?'Protecting…':'Protect now'}</button></div>
      </div>
      ${job?`<div class="backup-job"><strong>${esc(progress.phase||'Protecting')}</strong>${progress.copied!=null?` · ${Number(progress.copied).toLocaleString()}`:''}${progress.copiedBytes?` · ${bytes(progress.copiedBytes)}`:''}</div>`:''}
      ${total?`<div class="backup-plans">${PLAN_ORDER.map(level=>`<div class="backup-plan"><strong>${esc(PLANS[level].name)}</strong><b>${planCount(level).toLocaleString()}</b></div>`).join('')}</div>`:''}`;
    body.querySelector('[data-protect-now]')?.addEventListener('click',protectNow);
  }

  function ruleFor(importId) {
    return (model?.state?.rules||[]).find(rule=>rule.scopeType==='import'&&String(rule.scopeId)===String(importId))?.level||'normal';
  }
  function planOptions(selected) {
    return PLAN_ORDER.map(level=>`<option value="${level}" ${level===selected?'selected':''}>${esc(PLANS[level].name)} · ${esc(PLANS[level].short)}</option>`).join('');
  }
  function backupFor(id){return (model?.state?.backups||[]).find(item=>item.id===id);}
  function peerFor(id){return (model?.state?.peers||[]).find(item=>item.id===id);}

  function modeMap(snapshot) {
    const policies=new Map((snapshot?.policies||[]).map(item=>[`${item.locationId}\0${item.mediaType}`,item.representation]));
    const retention=new Map((snapshot?.retention||[]).map(item=>[`${item.locationId}\0${item.mediaType}`,item.allowOriginalRemoval===true]));
    return (locationId,mediaType)=>{
      const key=`${locationId}\0${mediaType}`;
      if(policies.get(key)!=='compact')return 'original';
      return retention.get(key)?'compact-only':'compact';
    };
  }

  function destinationStatus(location) {
    if(location.kind==='primary')return '';
    const peer=peerFor(location.id),backup=backupFor(location.id),parts=[];
    if(location.kind==='peer')parts.push(peer?.online?'Online':'Offline');
    else if(location.kind==='backup')parts.push(backup?'Connected':'Offline');
    if(!backup&&!peer?.online&&location.lastSeen)parts.push(age(location.lastSeen));
    return parts.join(' · ');
  }

  function representationSelect(location,mediaType,mode) {
    if(location.kind!=='backup')return '';
    const locationId=`backup:${location.id}`,current=mode(locationId,mediaType);
    return `<label>${mediaType==='image'?'Images':'Video'}<select data-representation data-location-id="${esc(locationId)}" data-location-name="${esc(location.name)}" data-media="${mediaType}"><option value="original" ${current==='original'?'selected':''}>Original</option><option value="compact" ${current==='compact'?'selected':''}>+ Squished</option><option value="compact-only" ${current==='compact-only'?'selected':''}>Squished</option></select></label>`;
  }

  function destinationRows() {
    const mode=modeMap(model?.storage);
    const locations=(model?.state?.locations||[]).filter(location=>['primary','backup','peer'].includes(location.kind));
    if(!locations.length)return '<div class="backup-empty">None</div>';
    return locations.map(location=>{
      const relied=location.reliability!=='low';
      const controls=location.kind==='primary'?'<span></span>':`<div class="backup-destination-controls">${representationSelect(location,'image',mode)}${representationSelect(location,'video',mode)}<button class="backup-rely ${relied?'':'off'}" type="button" data-rely="${esc(location.id)}" data-relied="${relied?'1':'0'}">${relied?'Counted':'Ignored'}</button></div>`;
      return `<div class="backup-destination-row"><div class="backup-row-copy"><strong>${esc(location.kind==='primary'?'Cloud':location.name)}</strong>${destinationStatus(location)?`<small>${esc(destinationStatus(location))}</small>`:''}</div>${controls}</div>`;
    }).join('');
  }

  function sourceRows() {
    const folders=(model?.state?.folders||[]).filter(folder=>folder.protected!==false&&Number(folder.importId)>0);
    if(!folders.length)return '<div class="backup-empty">None</div>';
    return folders.map(folder=>`<div class="backup-source-row" data-import-id="${Number(folder.importId)}"><div class="backup-row-copy"><strong>${esc(baseName(folder.path)||folder.path)}</strong><small>${esc(folder.path||'')}</small></div><select data-folder-plan>${planOptions(ruleFor(folder.importId))}</select></div>`).join('');
  }

  function ensureDialog() {
    if(dialog)return dialog;
    dialog=document.createElement('dialog');dialog.className='small-dialog backup-center-dialog';document.body.append(dialog);return dialog;
  }

  async function ensureStorageSnapshot() {
    if(model?.storageLoaded)return;
    try { model.storage=await server('/api/compression/storage-snapshot'); }
    catch { model.storage={policies:[],retention:[]}; }
    model.storageLoaded=true;
  }

  function renderDialog() {
    const box=ensureDialog();
    const summary=model?.state?.summary;
    const background=model?.state?.config?.background||'low';
    box.innerHTML=`
      <div class="dialog-head"><h3>Backup</h3><button class="icon" data-close>×</button></div>
      <div class="backup-settings">
        <section class="backup-settings-section"><h4>Protection</h4><div class="backup-plan-list">${PLAN_ORDER.map(level=>`<div class="backup-plan-row"><strong>${esc(PLANS[level].name)}</strong><b>${Number(summary?.levels?.[level]?.files||0).toLocaleString()}</b></div>`).join('')}</div></section>
        <section class="backup-settings-section"><h4>Folders</h4><div class="backup-source-list">${sourceRows()}</div></section>
        <section class="backup-settings-section"><h4>Destinations</h4><div class="backup-destination-list">${destinationRows()}</div></section>
        <section class="backup-settings-section"><h4>Automatic</h4><div class="backup-background"><strong>Protection</strong><select data-background><option value="low">Low</option><option value="normal">Normal</option><option value="paused">Off</option></select></div></section>
      </div>`;
    box.querySelector('[data-background]').value=background;
    box.querySelector('[data-close]').onclick=()=>box.close();
    box.querySelectorAll('[data-folder-plan]').forEach(select=>select.addEventListener('change',updateFolderPlan));
    box.querySelectorAll('[data-rely]').forEach(button=>button.addEventListener('click',toggleReliance));
    box.querySelectorAll('[data-representation]').forEach(select=>select.addEventListener('change',updateRepresentation));
    box.querySelector('[data-background]').addEventListener('change',updateBackground);
  }

  async function updateFolderPlan(event) {
    const select=event.currentTarget,importId=Number(select.closest('[data-import-id]')?.dataset.importId)||0;
    if(!importId)return;select.disabled=true;
    try { await control('/api/client/protection/folder-level',{method:'POST',body:{importId,level:select.value}});await refresh(true);renderDialog(); }
    catch(error){toast(error.message);}finally{select.disabled=false;}
  }

  async function toggleReliance(event) {
    const button=event.currentTarget,id=button.dataset.rely,relied=button.dataset.relied==='1';button.disabled=true;
    try { await control('/api/client/protection/location',{method:'POST',body:{id,reliability:relied?'low':'normal'}});await refresh(true);await ensureStorageSnapshot();renderDialog(); }
    catch(error){toast(error.message);}finally{button.disabled=false;}
  }

  async function updateRepresentation(event) {
    const select=event.currentTarget,next=select.value,locationId=select.dataset.locationId,mediaType=select.dataset.media,previous=modeMap(model?.storage)(locationId,mediaType);
    if(next==='compact-only'&&!confirm(`Use Squished only on ${select.dataset.locationName}?`)){select.value=previous;return;}
    select.disabled=true;
    try {
      if(next==='compact-only'){
        await server('/api/compression/storage-policy',{method:'POST',body:{locationId,mediaType,representation:'compact'}});
        await server('/api/compression/retention',{method:'POST',body:{locationId,mediaType,allowOriginalRemoval:true,confirmation:'compact-only'}});
      } else {
        await server('/api/compression/storage-policy',{method:'POST',body:{locationId,mediaType,representation:next}});
        if(next==='compact')await server('/api/compression/retention',{method:'POST',body:{locationId,mediaType,allowOriginalRemoval:false}});
      }
      model.storageLoaded=false;await ensureStorageSnapshot();renderDialog();
    } catch(error){toast(error.message);select.value=previous;}finally{select.disabled=false;}
  }

  async function updateBackground(event) {
    const select=event.currentTarget;select.disabled=true;
    try { await control('/api/client/protection/settings',{method:'POST',body:{background:select.value}});await refresh(true); }
    catch(error){toast(error.message);}finally{select.disabled=false;}
  }

  async function protectNow() {
    const button=section.querySelector('[data-protect-now]');if(button)button.disabled=true;
    try { await control('/api/client/protection/run',{method:'POST',body:{}});setTimeout(()=>refresh(true),180); }
    catch(error){toast(error.message);if(button)button.disabled=false;}
  }

  async function openManage() {
    if(!model)await refresh(true);
    await ensureStorageSnapshot();
    renderDialog();
    if(!dialog.open)dialog.showModal();
  }

  async function refresh(force=false) {
    clearTimeout(timer);timer=0;
    if(busy||(!force&&(document.hidden||storagePane.hidden)))return schedule(2500);
    busy=true;
    try {
      const next=await control('/api/client/protection/state');
      model={state:next,storage:model?.storage||{policies:[],retention:[]},storageLoaded:Boolean(model?.storageLoaded)};
      renderMain();
      if(dialog?.open){await ensureStorageSnapshot();renderDialog();}
      placeSection();
    } catch(error) { section.querySelector('[data-backup-body]').innerHTML=`<div class="backup-empty">${esc(error.message)}</div>`; }
    finally { busy=false;schedule(5000); }
  }

  function schedule(delay=0){clearTimeout(timer);timer=setTimeout(()=>refresh(false),Math.max(0,delay));}

  section.querySelector('[data-backup-manage]').addEventListener('click',openManage);
  const menuButton=document.querySelector('#clientProtection');
  if(menuButton){menuButton.querySelector('.menu-label')?.replaceChildren(document.createTextNode('Backup'));menuButton.onclick=event=>{event.preventDefault();openManage();};}

  window.addEventListener('mochimono:protection-changed',()=>refresh(true));
  window.addEventListener('focus',()=>schedule(0));
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)schedule(0);});
  schedule(100);
}
