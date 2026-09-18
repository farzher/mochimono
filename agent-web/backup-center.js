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
    .backup-health-ring{--p:0%;position:relative;width:70px;height:70px;display:grid;place-items:center;border-radius:50%;background:conic-gradient(var(--ring) var(--p),#2b272b 0)}.backup-health-ring:after{content:'';position:absolute;inset:7px;border-radius:50%;background:#141214}.backup-health-ring b{position:relative;z-index:1;color:#eee6e2;font-size:16px;font-weight:820;font-variant-numeric:tabular-nums}.backup-health.empty .backup-health-ring b{color:#8c8380}
    .backup-health-copy{min-width:0}.backup-health-title{color:#f1e9e5;font-size:21px;font-weight:820;letter-spacing:-.028em}.backup-health-sub{margin-top:4px;color:#9b918d;font-size:12.5px;font-weight:600;font-variant-numeric:tabular-nums}.backup-health-sub:empty{display:none}.backup-health-actions{display:flex;align-items:center;gap:8px}.backup-health-actions button{min-width:104px;height:37px;padding:0 14px;border-radius:9px;white-space:nowrap;font-size:12px;font-weight:780}
    .backup-review{display:flex;align-items:center;gap:12px;margin-top:10px;padding:11px 14px;border-radius:12px;background:#171417;box-shadow:inset 0 0 0 1px #32292b}.backup-review i{width:8px;height:8px;flex:0 0 auto;border-radius:50%;background:#d3a067}.backup-review div{min-width:0;flex:1}.backup-review strong{display:block;color:#dfd6d2;font-size:12.5px;font-weight:780}.backup-review small{display:block;margin-top:2px;color:#8d8480;font-size:10.5px}.backup-review button{height:30px;padding:0 10px;border-radius:8px;font-size:10.5px;font-weight:760}
    .backup-job{margin-top:11px}.backup-job-head{display:flex;align-items:center;justify-content:space-between;gap:12px;color:#c9bfbb;font-size:11.5px;font-weight:700}.backup-job-head span:last-child{color:#8d8581;font-variant-numeric:tabular-nums}.backup-progress{height:6px;margin-top:7px;overflow:hidden;border-radius:999px;background:#2b272b}.backup-progress i{display:block;height:100%;border-radius:inherit;background:var(--ring);transition:width .25s ease}.backup-progress.indeterminate i{width:34%;animation:backup-slide 1.3s ease-in-out infinite}

    dialog.backup-center-dialog{width:min(760px,calc(100vw - 28px));max-height:min(860px,calc(100dvh - 28px));padding:0;overflow:hidden}.backup-center-dialog .dialog-head{padding:19px 24px 16px;border-bottom:1px solid #292529}.backup-center-dialog .dialog-head h3{font-size:19px;font-weight:820;letter-spacing:-.025em}.backup-settings{max-height:calc(min(860px,100dvh - 28px) - 62px);overflow:auto;padding:22px 24px 26px;scrollbar-gutter:stable}
    .backup-dialog-summary{display:flex;align-items:center;gap:14px;padding:16px;border-radius:15px;background:#111012;box-shadow:inset 0 0 0 1px #292529}.backup-dialog-summary i{width:12px;height:12px;flex:0 0 auto;border-radius:50%;background:#7fbe90;box-shadow:0 0 0 7px rgba(127,190,144,.08)}.backup-dialog-summary.needs i{background:#d3a067;box-shadow:0 0 0 7px rgba(211,160,103,.08)}.backup-dialog-summary strong{display:block;color:#f0e8e4;font-size:17px;font-weight:810}.backup-dialog-summary span{display:block;margin-top:3px;color:#8f8783;font-size:12px;font-weight:620}.backup-summary-view{margin-left:auto;height:32px;padding:0 10px;border:0;border-radius:8px;background:#211e22;color:#cfc5c1;font-size:11px;font-weight:760;white-space:nowrap}.backup-summary-view:hover{background:#2b272c;color:#f0e8e4}
    .backup-simple-section{margin-top:22px}.backup-simple-section>h4,.backup-advanced-section>h4{margin:0 0 10px;color:#e7deda;font-size:14px;font-weight:800;letter-spacing:-.01em}
    .backup-location-list{display:grid;gap:8px}.backup-location-row{display:grid;grid-template-columns:12px minmax(0,1fr) auto;gap:12px;align-items:center;min-height:58px;padding:12px 14px;border-radius:13px;background:#151316;box-shadow:inset 0 0 0 1px #292529}.backup-location-dot{width:8px;height:8px;border-radius:50%;background:#7fbe90}.backup-location-row.offline .backup-location-dot{background:#d3a067}.backup-location-copy{min-width:0}.backup-location-copy strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e8dfdb;font-size:13.5px;font-weight:780}.backup-location-copy small{display:block;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#8e8582;font-size:11px}.backup-location-action{height:30px;padding:0 9px;border-radius:8px;background:transparent;color:#a19793;font-size:11px;font-weight:730}.backup-location-action:hover{background:#272327;color:#eee5e1}.backup-location-action.danger:hover{color:#efa09a}
    .backup-auto-row{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:13px 14px;border-radius:13px;background:#151316;box-shadow:inset 0 0 0 1px #292529}.backup-auto-row div{min-width:0}.backup-auto-row strong{display:block;color:#dfd6d2;font-size:13.5px;font-weight:760}.backup-auto-row small{display:block;margin-top:3px;color:#847c79;font-size:10.5px}.backup-auto-row select{width:145px;height:36px;padding:0 9px;font-size:11.5px;border-radius:8px}
    .backup-advanced{margin-top:22px;border-top:1px solid #292529}.backup-advanced>summary{display:flex;align-items:center;gap:8px;padding:18px 2px 4px;cursor:pointer;list-style:none;color:#a79e9a;font-size:12.5px;font-weight:760;user-select:none}.backup-advanced>summary::-webkit-details-marker{display:none}.backup-advanced>summary:after{content:'›';margin-left:auto;font-size:18px;transform:rotate(90deg);transition:transform .15s}.backup-advanced[open]>summary:after{transform:rotate(-90deg)}.backup-advanced-body{display:grid;gap:20px;padding-top:14px}.backup-advanced-section{padding:16px;border-radius:14px;background:#111012;box-shadow:inset 0 0 0 1px #292529}
    .backup-plan-list{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}.backup-plan-row{min-width:0;padding:12px;border-radius:11px;background:#171518}.backup-plan-row b{display:block;color:#eee6e2;font-size:20px;font-weight:820;line-height:1;font-variant-numeric:tabular-nums}.backup-plan-row strong{display:block;margin-top:7px;color:#c9bfbb;font-size:11.5px;font-weight:760}.backup-plan-row small{display:block;margin-top:2px;color:#7f7774;font-size:10px;font-weight:650}
    .backup-source-list,.backup-destination-list{display:grid;gap:8px}.backup-source-row,.backup-destination-row{display:grid;gap:10px;padding:12px;border-radius:11px;background:#171518}.backup-source-row{grid-template-columns:minmax(0,1fr) 170px;align-items:center}.backup-row-copy{min-width:0}.backup-row-copy strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e2d9d5;font-size:13px;font-weight:760}.backup-row-copy small{display:block;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#817976;font-size:10.5px}
    .backup-source-row select,.backup-destination-row select{width:100%;min-width:0;height:34px;padding:0 9px;font-size:11px;border-radius:8px}.backup-destination-controls{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto;gap:8px;align-items:end}.backup-destination-controls label{display:grid;gap:4px;color:#837b78;font-size:9.5px;font-weight:700}.backup-rely{height:34px;padding:0 10px;border:0;border-radius:8px;background:#2b272b;color:#d3c9c5;font-size:10.5px;font-weight:760;white-space:nowrap}.backup-rely.off{background:#171518;color:#756d6a}.backup-empty{padding:8px 2px;color:#817976;font-size:11.5px}
    @keyframes backup-slide{0%{transform:translateX(-115%)}50%{transform:translateX(105%)}100%{transform:translateX(315%)}}
    @media(max-width:700px){dialog.backup-center-dialog{width:min(620px,calc(100vw - 20px))}.backup-health{grid-template-columns:66px minmax(0,1fr)}.backup-health-ring{width:60px;height:60px}.backup-health-actions{grid-column:1/-1}.backup-health-actions button{width:100%}.backup-settings{padding:17px}.backup-plan-list{grid-template-columns:repeat(2,minmax(0,1fr))}.backup-source-row{grid-template-columns:1fr}.backup-destination-controls{grid-template-columns:1fr}.backup-rely{width:100%}.backup-auto-row{align-items:stretch;flex-direction:column}.backup-auto-row select{width:100%}}
    @media(prefers-reduced-motion:reduce){.backup-progress i{animation:none!important;transition:none!important}}
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

  function primaryStorageStatus() {
    try {
      const host=new URL(model?.state?.server||'').hostname.toLowerCase();
      return ['127.0.0.1','localhost','::1'].includes(host)?'Primary storage · This PC':'Primary storage';
    } catch { return 'Primary storage'; }
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

  function renderMain() {
    const body=section.querySelector('[data-backup-body]');
    const summary=model?.state?.summary;
    if(!summary){body.innerHTML='<div class="backup-empty">Unavailable</div>';return;}

    const total=Number(summary.files)||0;
    const protectedFiles=Number(summary.protectedFiles)||0;
    const needs=Number(summary.needsProtection)||0;
    const preparing=Number(summary.preparingFiles)||0;
    const remaining=Math.max(0,total-protectedFiles);
    const unlinked=Number(summary.unlinkedFiles)||0;
    const remoteOnly=Number(summary.remoteOnlyFiles)||0;
    const percent=total?Math.round(protectedFiles/total*100):0;
    const totalBytes=Number(summary.bytes)||0;
    const job=model.state.job?.status==='running'&&model.state.job?.type==='protection'?model.state.job:null;
    const progress=job?.progress||{};
    const title=!total?'Nothing selected for backup':remaining?job?'Backing up':`${remaining.toLocaleString()} need backup`:'Everything is protected';
    const parts=[];
    if(total)parts.push(`${protectedFiles.toLocaleString()} of ${total.toLocaleString()} protected`);
    if(preparing)parts.push(`${preparing.toLocaleString()} preparing`);
    if(remoteOnly)parts.push(`${remoteOnly.toLocaleString()} remote only`);
    if(totalBytes)parts.push(bytes(totalBytes));
    const stateClass=!total?'empty':remaining?'needs':'';
    const copied=Number(progress.copied)||0;
    const jobText=[progress.phase||'Protecting',copied?`${copied.toLocaleString()} copied`:'',progress.copiedBytes?bytes(progress.copiedBytes):''].filter(Boolean).join(' · ');
    const jobPercent=Number(progress.totalBytes)>0?Math.min(100,Number(progress.copiedBytes||progress.doneBytes||0)/Number(progress.totalBytes)*100):null;

    body.innerHTML=`
      <div class="backup-health ${stateClass}">
        <div class="backup-health-ring" style="--p:${Math.max(0,Math.min(100,percent))}%"><b>${total?`${percent}%`:'—'}</b></div>
        <div class="backup-health-copy">
          <div class="backup-health-title">${esc(title)}</div>
          <div class="backup-health-sub">${esc(parts.join(' · '))}</div>
          ${job?`<div class="backup-job"><div class="backup-job-head"><span>${esc(jobText)}</span>${jobPercent!=null?`<span>${Math.round(jobPercent)}%</span>`:''}</div><div class="backup-progress ${jobPercent==null?'indeterminate':''}"><i style="width:${jobPercent==null?'34%':`${Math.max(1,jobPercent)}%`}"></i></div></div>`:''}
        </div>
        <div class="backup-health-actions">
          ${total?`<button class="secondary" type="button" data-view-protection="managed">View files</button>`:''}
          ${job?`<button class="secondary" type="button" disabled>Working…</button>`:remaining?`<button class="secondary" type="button" data-protect-now>Protect now</button>`:''}
        </div>
      </div>
      ${unlinked?`<div class="backup-review"><i></i><div><strong>${unlinked.toLocaleString()} ${unlinked===1?'file needs':'files need'} review</strong><small>No longer linked to a current source.</small></div><button class="secondary" type="button" data-view-protection="unlinked">Review</button></div>`:''}`;
    body.querySelectorAll('[data-view-protection]').forEach(button=>button.addEventListener('click',()=>viewProtection(button.dataset.viewProtection)));
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

  function simpleDestinationRows() {
    const attached=new Map((model?.state?.backups||[]).map(item=>[String(item.id),item]));
    const peers=new Map((model?.state?.peers||[]).map(item=>[String(item.id),item]));
    const locations=(model?.state?.locations||[]).filter(location=>['primary','backup','peer'].includes(location.kind));
    if(!locations.length)return '<div class="backup-empty">No backup locations yet.</div>';
    return locations.map(location=>{
      if(location.kind==='primary'){
        return `<div class="backup-location-row"><i class="backup-location-dot"></i><div class="backup-location-copy"><strong>Mochimono storage</strong><small>${esc(primaryStorageStatus())}</small></div></div>`;
      }
      if(location.kind==='backup'){
        const backup=attached.get(String(location.id));
        if(backup){
          const details=[backup.path,backup.bytes?`${bytes(backup.bytes)} stored`:''].filter(Boolean).join(' · ');
          return `<div class="backup-location-row"><i class="backup-location-dot"></i><div class="backup-location-copy"><strong>${esc(location.name)}</strong><small>Connected${details?` · ${esc(details)}`:''}</small></div></div>`;
        }
        const seen=location.lastSeen?age(location.lastSeen):'';
        return `<div class="backup-location-row offline"><i class="backup-location-dot"></i><div class="backup-location-copy"><strong>${esc(location.name)}</strong><small>Disconnected · remembered backup${seen?` · last seen ${esc(seen)} ago`:''}</small></div><button class="backup-location-action danger" type="button" data-forget-backup="${esc(location.id)}" data-name="${esc(location.name)}">Forget</button></div>`;
      }
      const peer=peers.get(String(location.id));
      const online=Boolean(peer?.online);
      return `<div class="backup-location-row ${online?'':'offline'}"><i class="backup-location-dot"></i><div class="backup-location-copy"><strong>${esc(location.name)}</strong><small>${online?'Remote backup available':`Remote backup offline${location.lastSeen?` · last seen ${esc(age(location.lastSeen))} ago`:''}`}</small></div></div>`;
    }).join('');
  }

  function representationSelect(location,mediaType,mode) {
    if(location.kind!=='backup')return '';
    const locationId=`backup:${location.id}`,current=mode(locationId,mediaType);
    return `<label>${mediaType==='image'?'Images':'Video'}<select data-representation data-location-id="${esc(locationId)}" data-location-name="${esc(location.name)}" data-media="${mediaType}"><option value="original" ${current==='original'?'selected':''}>Original</option><option value="compact" ${current==='compact'?'selected':''}>Original + Squished</option><option value="compact-only" ${current==='compact-only'?'selected':''}>Squished only</option></select></label>`;
  }

  function advancedDestinationRows() {
    const mode=modeMap(model?.storage);
    const attached=new Set((model?.state?.backups||[]).map(item=>String(item.id)));
    const locations=(model?.state?.locations||[]).filter(location=>
      (location.kind==='backup'&&attached.has(String(location.id)))||location.kind==='peer'
    );
    if(!locations.length)return '';
    return locations.map(location=>{
      const relied=location.reliability!=='low';
      const controls=`<div class="backup-destination-controls">${representationSelect(location,'image',mode)}${representationSelect(location,'video',mode)}<button class="backup-rely ${relied?'':'off'}" title="Whether this location counts toward protection targets" type="button" data-rely="${esc(location.id)}" data-relied="${relied?'1':'0'}">${relied?'Counts':'Ignored'}</button></div>`;
      return `<div class="backup-destination-row"><div class="backup-row-copy"><strong>${esc(location.name)}</strong><small>${location.kind==='peer'?'Remote backup':'Connected backup drive'}</small></div>${controls}</div>`;
    }).join('');
  }

  function sourceRows() {
    const folders=(model?.state?.folders||[]).filter(folder=>folder.protected!==false&&Number(folder.importId)>0);
    if(!folders.length)return '';
    return folders.map(folder=>`<div class="backup-source-row" data-import-id="${Number(folder.importId)}"><div class="backup-row-copy"><strong>${esc(baseName(folder.path)||folder.path)}</strong><small>${esc(folder.path||'')}</small></div><select data-folder-plan>${planOptions(ruleFor(folder.importId))}</select></div>`).join('');
  }

  function ensureDialog() {
    if(dialog)return dialog;
    dialog=document.createElement('dialog');dialog.className='backup-center-dialog';document.body.append(dialog);return dialog;
  }

  async function ensureStorageSnapshot() {
    if(model?.storageLoaded)return;
    try { model.storage=await server('/api/compression/storage-snapshot'); }
    catch { model.storage={policies:[],retention:[]}; }
    model.storageLoaded=true;
  }

  function renderDialog() {
    const box=ensureDialog();
    const advancedOpen=Boolean(box.querySelector('.backup-advanced')?.open);
    const summary=model?.state?.summary||{};
    const background=model?.state?.config?.background||'low';
    const total=Number(summary.files)||0;
    const protectedFiles=Number(summary.protectedFiles)||0;
    const remaining=Math.max(0,total-protectedFiles);
    const unlinked=Number(summary.unlinkedFiles)||0;
    const remoteOnly=Number(summary.remoteOnlyFiles)||0;
    const levels=PLAN_ORDER.filter(level=>Number(summary.levels?.[level]?.files)>0);
    const profile=levels.length===1?`${PLANS[levels[0]].name} protection`:levels.length>1?'Mixed protection':'No protected files';
    const folders=sourceRows();
    const storageRules=advancedDestinationRows();
    box.innerHTML=`
      <div class="dialog-head"><h3>Backup</h3><button class="icon" data-close>×</button></div>
      <div class="backup-settings">
        <div class="backup-dialog-summary ${remaining?'needs':''}"><i></i><div><strong>${!total?'Nothing selected for backup':remaining?`${protectedFiles.toLocaleString()} of ${total.toLocaleString()} protected`:'Everything is protected'}</strong><span>${total?`${profile}${remoteOnly?` · ${remoteOnly.toLocaleString()} remote only`:''}`:'Add or protect a source folder to start.'}</span></div>${total?'<button class="backup-summary-view" type="button" data-view-protection="managed">View files</button>':''}</div>
        ${unlinked?`<div class="backup-review"><i></i><div><strong>${unlinked.toLocaleString()} ${unlinked===1?'file needs':'files need'} review</strong><small>Stored by Mochimono but no longer linked to a current source.</small></div><button class="secondary" type="button" data-view-protection="unlinked">Review</button></div>`:''}

        <section class="backup-simple-section"><h4>Backup locations</h4><div class="backup-location-list">${simpleDestinationRows()}</div></section>

        <section class="backup-simple-section"><h4>Automatic backup</h4><div class="backup-auto-row"><div><strong>Background backup</strong><small>Mochimono keeps your copies up to date automatically.</small></div><select data-background><option value="low">Low impact</option><option value="normal">Normal</option><option value="paused">Off</option></select></div></section>

        <details class="backup-advanced">
          <summary>Advanced settings</summary>
          <div class="backup-advanced-body">
            <section class="backup-advanced-section"><h4>Protection policy</h4><div class="backup-plan-list">${PLAN_ORDER.map(level=>`<div class="backup-plan-row"><b>${Number(summary.levels?.[level]?.files||0).toLocaleString()}</b><strong>${esc(PLANS[level].name)}</strong><small>${esc(PLANS[level].short)}</small></div>`).join('')}</div></section>
            ${folders?`<section class="backup-advanced-section"><h4>Folder overrides</h4><div class="backup-source-list">${folders}</div></section>`:''}
            ${storageRules?`<section class="backup-advanced-section"><h4>Storage rules</h4><div class="backup-destination-list">${storageRules}</div></section>`:''}
          </div>
        </details>
      </div>`;
    box.querySelector('[data-background]').value=background;
    if(advancedOpen)box.querySelector('.backup-advanced').open=true;
    box.querySelector('[data-close]').onclick=()=>box.close();
    box.querySelectorAll('[data-folder-plan]').forEach(select=>select.addEventListener('change',updateFolderPlan));
    box.querySelectorAll('[data-rely]').forEach(button=>button.addEventListener('click',toggleReliance));
    box.querySelectorAll('[data-representation]').forEach(select=>select.addEventListener('change',updateRepresentation));
    box.querySelectorAll('[data-forget-backup]').forEach(button=>button.addEventListener('click',forgetBackup));
    box.querySelectorAll('[data-view-protection]').forEach(button=>button.addEventListener('click',()=>viewProtection(button.dataset.viewProtection)));
    box.querySelector('[data-background]').addEventListener('change',updateBackground);
  }

  function viewProtection(mode) {
    if(dialog?.open)dialog.close();
    document.querySelector('[data-client-tab="library"]')?.click();
    const open=attempt=>{
      const library=document.querySelector('#filesFrame')?.contentWindow?.mochimonoLibrary;
      if(library?.showProtection)return library.showProtection(mode);
      if(attempt<20)setTimeout(()=>open(attempt+1),50);
    };
    open(0);
  }

  async function forgetBackup(event) {
    const button=event.currentTarget,id=button.dataset.forgetBackup,name=button.dataset.name||'this backup drive';
    button.disabled=true;
    try{
      const impact=await server(`/api/protection/locations/${encodeURIComponent(id)}/impact`).catch(()=>null);
      const affected=Number(impact?.newlyUnderProtected)||0;
      const copies=Number(impact?.files)||0;
      const consequence=affected
        ? `\n\n${affected.toLocaleString()} managed ${affected===1?'file will':'files will'} fall below the requested protection level.`
        : copies ? `\n\n${copies.toLocaleString()} managed ${copies===1?'file has':'files have'} a copy there, but required protection remains satisfied without it.` : '';
      if(!confirm(`Forget ${name}?${consequence}\n\nFiles on the physical drive are not erased.`))return;
      await control('/api/client/protection/backup/forget',{method:'POST',body:{id}});
      model.storageLoaded=false;
      await refresh(true);
      toast('Backup forgotten');
    }catch(error){toast(error.message);}
    finally{button.disabled=false;}
  }

  async function updateFolderPlan(event) {
    const select=event.currentTarget,importId=Number(select.closest('[data-import-id]')?.dataset.importId)||0;
    if(!importId)return;select.disabled=true;
    try { await control('/api/client/protection/folder-level',{method:'POST',body:{importId,level:select.value}});await refresh(true);renderDialog(); }
    catch(error){toast(error.message);}finally{select.disabled=false;}
  }

  async function toggleReliance(event) {
    const button=event.currentTarget,id=button.dataset.rely,relied=button.dataset.relied==='1';button.disabled=true;
    try {
      if(relied){
        const impact=await server(`/api/protection/locations/${encodeURIComponent(id)}/impact`).catch(()=>null);
        const affected=Number(impact?.newlyUnderProtected)||0;
        if(affected&&!confirm(`Stop counting this storage toward protection?\n\n${affected.toLocaleString()} managed ${affected===1?'file will':'files will'} fall below the requested protection level. No copies are deleted.`))return;
      }
      await control('/api/client/protection/location',{method:'POST',body:{id,reliability:relied?'low':'normal'}});
      await refresh(true);await ensureStorageSnapshot();renderDialog();
    } catch(error){toast(error.message);}finally{button.disabled=false;}
  }

  async function updateRepresentation(event) {
    const select=event.currentTarget,next=select.value,locationId=select.dataset.locationId,mediaType=select.dataset.media,previous=modeMap(model?.storage)(locationId,mediaType);
    if(next==='compact-only'&&!confirm(`Use Squished only on ${select.dataset.locationName}?\n\nAfter a Squished copy is verified, Mochimono may remove the Original from this storage location. Other copies are unchanged.`)){select.value=previous;return;}
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
      window.dispatchEvent(new CustomEvent('mochimono:protection-summary',{detail:next.summary||{}}));
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
