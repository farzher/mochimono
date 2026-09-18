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
    .backup-center{margin-top:24px;padding-top:30px;border-top:1px solid #211e21}
    .backup-center-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:13px}.backup-center-head h2{margin:0;color:#f0e8e4;font-size:21px;font-weight:800;letter-spacing:-.03em}.backup-center-manage{height:32px;padding:0 10px;border:0;border-radius:8px;background:transparent;color:#9e9490;font-size:12px;font-weight:760}.backup-center-manage:hover{background:#211e22;color:#eee6e2}
    .backup-health{--ring:#7fbe90;display:grid;grid-template-columns:76px minmax(0,1fr) auto;gap:18px;align-items:center;padding:18px 19px;border-radius:18px;background:#141214;box-shadow:inset 0 0 0 1px #2b272b}.backup-health.needs{--ring:#d3a067}.backup-health.empty{--ring:#686164}
    .backup-health-ring{--p:0;position:relative;width:70px;height:70px;display:grid;place-items:center;border-radius:50%;background:conic-gradient(var(--ring) calc(var(--p)*1%),#2b272b 0)}.backup-health-ring:after{content:'';position:absolute;inset:7px;border-radius:50%;background:#141214}.backup-health-ring b{position:relative;z-index:1;color:#eee6e2;font-size:16px;font-weight:820;font-variant-numeric:tabular-nums}.backup-health.empty .backup-health-ring b{color:#8c8380}
    .backup-health-copy{min-width:0}.backup-health-title{color:#f1e9e5;font-size:21px;font-weight:820;letter-spacing:-.028em}.backup-health-sub{margin-top:4px;color:#9b918d;font-size:12.5px;font-weight:600;font-variant-numeric:tabular-nums}.backup-health-sub:empty{display:none}.backup-health-actions{display:flex;align-items:center}.backup-health-actions button{min-width:104px;height:37px;padding:0 14px;border-radius:9px;white-space:nowrap;font-size:12px;font-weight:780}
    .backup-job{margin-top:11px}.backup-job-head{display:flex;align-items:center;justify-content:space-between;gap:12px;color:#c9bfbb;font-size:11.5px;font-weight:700}.backup-job-head span:last-child{color:#8d8581;font-variant-numeric:tabular-nums}.backup-progress{height:6px;margin-top:7px;overflow:hidden;border-radius:999px;background:#2b272b}.backup-progress i{display:block;height:100%;border-radius:inherit;background:var(--ring);transition:width .25s ease}.backup-progress.indeterminate i{width:34%;animation:backup-slide 1.3s ease-in-out infinite}
    .backup-center-dialog{width:min(860px,calc(100vw - 28px));max-height:min(850px,calc(100dvh - 28px));padding:0;overflow:hidden}.backup-center-dialog .dialog-head{padding:17px 20px 14px;border-bottom:1px solid #292529}.backup-center-dialog .dialog-head h3{font-size:18px;font-weight:820;letter-spacing:-.02em}.backup-settings{max-height:calc(min(850px,100dvh - 28px) - 60px);overflow:auto;display:grid;padding:20px 22px 24px}.backup-settings-section{display:grid;gap:11px;padding:22px 0;border-top:1px solid #282428}.backup-settings-section:first-child{padding-top:0;border-top:0}.backup-settings-section h4{margin:0;color:#e6ddd9;font-size:15px;font-weight:800;letter-spacing:-.015em}
    .backup-plan-list{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}.backup-plan-row{min-width:0;padding:14px;border-radius:13px;background:#141214;box-shadow:inset 0 0 0 1px #292529}.backup-plan-row b{display:block;color:#eee6e2;font-size:22px;font-weight:820;line-height:1;font-variant-numeric:tabular-nums}.backup-plan-row strong{display:block;margin-top:8px;color:#c9bfbb;font-size:12px;font-weight:760}.backup-plan-row small{display:block;margin-top:2px;color:#7f7774;font-size:10.5px;font-weight:650}
    .backup-source-list,.backup-destination-list{display:grid}.backup-source-row,.backup-destination-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px;align-items:center;min-height:58px;padding:11px 4px;border-top:1px solid #252225}.backup-source-row:first-child,.backup-destination-row:first-child{border-top:0}.backup-row-copy{min-width:0}.backup-row-copy strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e2d9d5;font-size:14px;font-weight:760}.backup-row-copy small{display:block;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#817976;font-size:10.5px}
    .backup-source-row select,.backup-destination-row select,.backup-background select{width:auto;min-width:138px;height:34px;padding:0 9px;font-size:11.5px;border-radius:8px}.backup-destination-controls{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap}.backup-destination-controls label{display:grid;gap:3px;color:#837b78;font-size:9.5px;font-weight:700}.backup-destination-controls select{min-width:112px}.backup-rely{height:34px;padding:0 10px;border:0;border-radius:8px;background:#2b272b;color:#d3c9c5;font-size:10.5px;font-weight:760}.backup-rely.off{background:#171518;color:#756d6a}
    .backup-background{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:52px;padding:0 4px}.backup-background strong{color:#dfd6d2;font-size:14px;font-weight:760}.backup-empty{padding:13px 2px;color:#817976;font-size:12px}
    @keyframes backup-slide{0%{transform:translateX(-115%)}50%{transform:translateX(105%)}100%{transform:translateX(315%)}}
    @media(max-width:760px){.backup-health{grid-template-columns:66px minmax(0,1fr)}.backup-health-ring{width:60px;height:60px}.backup-health-actions{grid-column:1/-1}.backup-health-actions button{width:100%}.backup-plan-list{grid-template-columns:repeat(2,minmax(0,1fr))}.backup-source-row,.backup-destination-row{grid-template-columns:1fr}.backup-destination-controls{justify-content:flex-start}.backup-settings{padding:17px}}
    @media(prefers-reduced-motion:reduce){.backup-progress i{animation:none!important;transition:none!important}}
  `
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
