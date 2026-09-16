const activityHost = document.querySelector('.client-head-actions');
const activityToast = document.querySelector('#toast');

if (activityHost) {
  const FRIEND_ORIGIN = `http://${location.hostname.includes(':') ? `[${location.hostname}]` : location.hostname}:8644`;
  const RECENT_KEY = 'mochimono.activity.recent.v1';
  const MAX_RECENT = 40;
  let dialog = null;
  let button = null;
  let timer = 0;
  let busy = false;
  let lastModel = null;

  const style = document.createElement('style');
  style.textContent = `
    .activity-button{height:31px;display:flex;align-items:center;gap:7px;padding:0 9px;border:1px solid transparent;border-radius:8px;background:transparent;color:#8d8584;font-size:10px;font-weight:680;white-space:nowrap}
    .activity-button:hover,.activity-button.active{border-color:#2d292d;background:#211e22;color:#eee7e3}.activity-dot{width:6px;height:6px;border-radius:50%;background:#696164}.activity-button.working .activity-dot{background:#e99b95;animation:activity-pulse .9s ease-in-out infinite}.activity-button.issue .activity-dot{background:#d3a067}.activity-count{color:#d8cfcb;font-variant-numeric:tabular-nums}
    .activity-dialog{width:min(720px,calc(100vw - 26px));max-height:min(820px,calc(100dvh - 26px));padding:0;overflow:hidden}.activity-dialog .dialog-head{padding:14px 16px 11px;border-bottom:1px solid #292529}.activity-dialog-body{max-height:calc(min(820px,100dvh - 26px) - 58px);overflow:auto;padding:13px 16px 17px}.activity-summary{display:flex;align-items:center;gap:8px;margin-bottom:12px;color:#89817e;font-size:10px}.activity-summary strong{color:#d9d0cc;font-size:12px}.activity-summary .spacer{flex:1}
    .activity-section{margin-top:16px}.activity-section:first-child{margin-top:0}.activity-section-head{display:flex;align-items:baseline;gap:8px;margin:0 0 7px;color:#77706e;font-size:9px;font-weight:720;text-transform:uppercase;letter-spacing:.055em}.activity-section-head b{color:#99908d;font-size:9px}.activity-list{display:grid;gap:6px}.activity-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;padding:10px 11px;border:1px solid #292529;border-radius:10px;background:#111012}.activity-row.running{border-color:#3b3032;background:#151113}.activity-row.error{border-color:#442d31}.activity-main{min-width:0}.activity-title{display:flex;align-items:center;gap:7px;color:#d8cfcb;font-size:11px;font-weight:710}.activity-kind{flex:0 0 auto;padding:2px 5px;border-radius:99px;background:#282329;color:#928987;font-size:8px;font-weight:750;text-transform:uppercase;letter-spacing:.04em}.activity-title span:last-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.activity-detail{margin-top:4px;color:#817976;font-size:9.5px;line-height:1.4}.activity-current{display:block;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#6f6968;font:9px ui-monospace,SFMono-Regular,Consolas,monospace}.activity-progress{height:4px;margin-top:7px;overflow:hidden;border-radius:99px;background:#292529}.activity-progress i{display:block;height:100%;min-width:2px;border-radius:inherit;background:#e99b95;transition:width .3s ease}.activity-progress.indeterminate i{width:32%;animation:activity-slide 1.3s ease-in-out infinite}.activity-side{display:flex;align-items:start;gap:7px;color:#756e6c;font-size:9px;white-space:nowrap}.activity-side time{padding-top:4px}.activity-cancel{border:0;background:transparent;color:#918784;padding:3px 4px;font-size:9px;font-weight:700}.activity-cancel:hover{color:#e2d8d4}.activity-empty{padding:15px 10px;color:#77706e;text-align:center;font-size:10px}.activity-wait{color:#a99386}.activity-error-text{color:#c99a97}.activity-recent .activity-row{padding-top:8px;padding-bottom:8px;background:#0f0e10}.activity-recent .activity-detail{margin-top:2px}
    @keyframes activity-pulse{0%,100%{transform:scale(.72);opacity:.55}50%{transform:scale(1.2);opacity:1}}@keyframes activity-slide{0%{transform:translateX(-115%)}50%{transform:translateX(105%)}100%{transform:translateX(315%)}}
    @media(max-width:700px){.activity-button{padding:0 7px}.activity-button .activity-label{display:none}.activity-row{grid-template-columns:1fr}.activity-side{justify-content:flex-end}.activity-dialog-body{padding-left:11px;padding-right:11px}}
    @media(prefers-reduced-motion:reduce){.activity-dot,.activity-progress i{animation:none!important;transition:none!important}}
  `;
  document.head.append(style);

  button = document.createElement('button');
  button.type = 'button';
  button.className = 'activity-button';
  button.title = 'Activity queue';
  button.innerHTML = '<i class="activity-dot"></i><span class="activity-label">Activity</span><b class="activity-count"></b>';
  const menu = activityHost.querySelector('.client-menu');
  menu?.before(button);
  if (!menu) activityHost.append(button);

  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot',"'":'&#39;' }[char]));
  const baseName = value => String(value || '').replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).at(-1) || String(value || '');
  function bytes(number) { const units=['B','KB','MB','GB','TB','PB']; let value=Math.max(0,Number(number)||0),unit=0; while(value>=1000&&unit<units.length-1){value/=1000;unit++;} return `${value<10&&unit?value.toFixed(1):Math.round(value)} ${units[unit]}`; }
  function age(value) { const time=new Date(value||0).getTime(); if(!time)return ''; const s=Math.max(0,Math.floor((Date.now()-time)/1000)); if(s<60)return s<8?'just now':`${s}s ago`; const m=Math.floor(s/60); if(m<60)return `${m}m ago`; const h=Math.floor(m/60); if(h<48)return `${h}h ago`; return `${Math.floor(h/24)}d ago`; }
  function duration(seconds){seconds=Math.max(0,Math.round(Number(seconds)||0));if(seconds<60)return `${seconds}s`;const m=Math.floor(seconds/60);if(m<60)return `${m}m`;return `${Math.floor(m/60)}h ${m%60}m`;}
  function toast(text){if(!activityToast)return;activityToast.textContent=text;activityToast.classList.add('show');clearTimeout(activityToast.timer);activityToast.timer=setTimeout(()=>activityToast.classList.remove('show'),2800);}

  async function request(url, options={}) {
    const response=await fetch(url,{cache:'no-store',...options,headers:{'content-type':'application/json',...(options.headers||{})},body:options.body&&typeof options.body!=='string'?JSON.stringify(options.body):options.body});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(data.error||response.statusText);
    return data;
  }

  function savedRecent(){try{const value=JSON.parse(localStorage.getItem(RECENT_KEY)||'[]');return Array.isArray(value)?value:[];}catch{return [];}}
  function saveRecent(items){try{localStorage.setItem(RECENT_KEY,JSON.stringify(items.slice(0,MAX_RECENT)));}catch{}}
  function rememberAgent(job){
    if(!job?.id||job.status==='running'||job.status==='queued')return;
    const recent=savedRecent();
    if(recent.some(item=>item.id===job.id))return;
    recent.unshift({id:job.id,type:job.type,label:job.label,status:job.status,error:job.error||'',result:job.result||null,startedAt:job.startedAt||null,finishedAt:job.finishedAt||new Date().toISOString()});
    saveRecent(recent);
  }

  function operation(job){
    const label=String(job?.label||'');
    if(/^Friend /.test(label))return {kind:'Friend Drive',title:label.replace(/^Friend (update|verify|restore) /,(_,verb)=>`${verb[0].toUpperCase()+verb.slice(1)} · `)};
    if(job?.type==='sync')return {kind:'Index',title:label.replace(/^(Sync|Check|Update) /,'')};
    if(job?.type==='backup'||job?.type==='protection')return {kind:'Backup',title:label.replace(/^Update /,'')};
    if(job?.type==='verify')return {kind:'Verify',title:label.replace(/^Verify /,'')};
    if(job?.type==='restore')return {kind:'Restore',title:label.replace(/^Restore /,'')};
    return {kind:'Work',title:label||job?.type||'Working'};
  }

  function progress(job){
    const p=job?.progress||{};
    const totalBytes=Number(p.totalBytes)||0,doneBytes=Math.min(totalBytes,Number(p.doneBytes)||Number(p.copiedBytes)||0);
    const total=Number(p.total)||0,checked=Number(p.checked??p.hashed??p.scanned)||0;
    const percent=totalBytes?doneBytes/totalBytes*100:total?checked/total*100:null;
    const details=[];
    if(p.phase)details.push(p.phase);
    if(totalBytes)details.push(`${bytes(doneBytes)} / ${bytes(totalBytes)}`);
    else if(total)details.push(`${checked.toLocaleString()} / ${total.toLocaleString()}`);
    else if(p.scanned!=null)details.push(`${Number(p.scanned).toLocaleString()} files`);
    if(p.copied!=null)details.push(`${Number(p.copied).toLocaleString()} copied`);
    if(p.already!=null)details.push(`${Number(p.already).toLocaleString()} already there`);
    if(p.skipped!=null&&Number(p.skipped)>0)details.push(`${Number(p.skipped).toLocaleString()} waiting for other storage`);
    if(p.remainingCapacityBytes!=null)details.push(`${bytes(p.remainingCapacityBytes)} free`);
    if(p.speedBps>0)details.push(`${bytes(p.speedBps)}/s`);
    if(p.etaSeconds>0)details.push(`${duration(p.etaSeconds)} left`);
    return {percent,details:details.join(' · '),current:p.current||'',indeterminate:Boolean(p.indeterminate)||percent==null};
  }

  function folderItems(state, stats){
    const currentPath=String(state?.job?.progress?.path||'').toLowerCase();
    const configured=new Map((state?.settings?.folders||[]).map(item=>[String(item.path||'').toLowerCase(),item]));
    const active=[],queued=[],recent=[];
    for(const folder of stats?.folders||[]){
      const path=String(folder.path||''),key=path.toLowerCase(),name=baseName(path)||path;
      const globalHere=currentPath&&key===currentPath;
      const diagnostics=folder.diagnostics||{};
      if(diagnostics.running&&!globalHere){
        const hashing=diagnostics.jobType==='hash'||folder.hashing;
        active.push({id:`folder:${key}`,source:'folder',kind:hashing?'Hash':'Index',title:name,status:'running',startedAt:null,progress:{phase:hashing?'Hashing':'Indexing',path,current:'',hashed:diagnostics.hashProcessed,total:diagnostics.hashTotal,scanned:folder.files},cancelable:false});
      } else if(folder.pending&&!globalHere){
        queued.push({id:`folder:${key}`,source:'folder',kind:folder.protected===false?'Index':'Sync',title:name,status:'queued',queuedAt:null,detail:folder.waitingForIdle?'Waiting for idle':'Queued',cancelable:false});
      }
      if(folder.hashPending>0&&!folder.hashing){
        queued.push({id:`hash:${key}`,source:'folder',kind:'Hash',title:name,status:'queued',queuedAt:null,detail:`${Number(folder.hashPending).toLocaleString()} files${folder.hashWaiting?' · waiting for idle':''}`,cancelable:false});
      }
      const configuredFolder=configured.get(key);
      const finished=folder.protected===false?folder.lastIndexed:configuredFolder?.lastSynced;
      if(finished)recent.push({id:`recent-folder:${key}:${finished}`,source:'folder',kind:folder.protected===false?'Index':'Sync',title:name,status:'done',finishedAt:finished,detail:folder.protected===false?`${Number(folder.files||0).toLocaleString()} files indexed`:'Folder synced'});
    }
    return {active,queued,recent};
  }

  function squishItems(work){
    const jobs=work?.jobs||[],active=[],queued=[],recent=[];
    for(const item of jobs.filter(item=>item.status==='running'))active.push({id:`squish:${item.id}`,rawId:item.id,source:'squish',kind:'Squish',title:item.filename||item.originalHash?.slice(0,12)||'Media',status:'running',startedAt:item.startedAt,progress:{phase:item.message||'Squishing',doneBytes:0,totalBytes:0,current:item.filename||'',indeterminate:item.progress<=0},percent:Number(item.progress)||0,cancelable:true});
    const waiting=jobs.filter(item=>item.status==='queued');
    if(waiting.length){
      const byKind=new Map();
      for(const item of waiting){const key=item.mediaType||item.kind||'media';const group=byKind.get(key)||[];group.push(item);byKind.set(key,group);}
      for(const [kind,items] of byKind)queued.push({id:`squish-batch:${kind}`,source:'squish-batch',rawIds:items.map(item=>item.id),kind:'Squish',title:`${items.length.toLocaleString()} ${kind==='image'?'photos':kind==='video'?'videos':'files'}`,status:'queued',queuedAt:items.at(-1)?.createdAt||items[0]?.createdAt,detail:'Batched',cancelable:true});
    }
    for(const item of jobs.filter(item=>['done','error','canceled'].includes(item.status)).slice(0,16))recent.push({id:`squish:${item.id}`,source:'squish',kind:'Squish',title:item.filename||item.originalHash?.slice(0,12)||'Media',status:item.status,finishedAt:item.finishedAt,error:item.status==='error'?item.message:'',detail:item.status==='done'?'Squished':''});
    return {active,queued,recent};
  }

  function previewItems(state){
    const previews=state?.previews||{},active=Number(previews.active)||0,queued=(Number(previews.urgent)||0)+(Number(previews.priority)||0)+(Number(previews.queued)||0);
    if(!active&&!queued)return {active:[],queued:[]};
    const waiting=state?.settings?.thumbnailMode==='off'?'Paused':state?.background?.waiting?'Waiting for idle':'';
    const item={id:'previews',source:'preview',kind:'Preview',title:'Thumbnails',status:active?'running':'queued',detail:[active?`${active} generating`:'',queued?`${queued.toLocaleString()} queued`:'',waiting].filter(Boolean).join(' · '),progress:{phase:waiting||'Generating previews',indeterminate:true},cancelable:false};
    return active?{active:[item],queued:[]}:{active:[],queued:[item]};
  }

  function friendRecent(friendData){
    const result=[];
    for(const target of friendData?.backups||[]){
      if(target.lastBackupAt)result.push({id:`friend-backup:${target.id}:${target.lastBackupAt}`,source:'friend',kind:'Friend Drive',title:target.name,status:'done',finishedAt:target.lastBackupAt,detail:target.lastCapacitySkippedBytes?`Updated · ${bytes(target.lastCapacitySkippedBytes)} left for other storage`:'Updated'});
      if(target.lastVerifiedAt)result.push({id:`friend-verify:${target.id}:${target.lastVerifiedAt}`,source:'friend',kind:'Friend Drive',title:target.name,status:target.lastVerifyBad?'error':'done',finishedAt:target.lastVerifiedAt,detail:target.lastVerifyBad?`${target.lastVerifyBad} damaged`:'Verified'});
      if(target.lastRestoreAt)result.push({id:`friend-restore:${target.id}:${target.lastRestoreAt}`,source:'friend',kind:'Friend Drive',title:target.name,status:'done',finishedAt:target.lastRestoreAt,detail:'Restored'});
    }
    return result;
  }

  function jobItem(item, source, cancelable=false){
    const op=operation(item);
    return {...item,source,kind:op.kind,title:op.title,cancelable};
  }

  function buildModel(state,stats,work,friends){
    rememberAgent(state?.job);
    const active=[],queued=[],recent=[];
    if(state?.job?.status==='running') active.push(jobItem(state.job,'agent',true));
    for(const item of state?.job?.queue||[]) queued.push(jobItem(item,'agent-queue',true));
    const folders=folderItems(state,stats),squish=squishItems(work),previews=previewItems(state);
    active.push(...folders.active,...squish.active,...previews.active);
    queued.push(...folders.queued,...squish.queued,...previews.queued);
    const backendRecent=(state?.job?.recent||[]).map(item=>jobItem(item,'agent-history',false));
    const browserRecent=savedRecent().map(item=>jobItem(item,'agent-history',false));
    recent.push(...backendRecent,...browserRecent,...folders.recent,...squish.recent,...friendRecent(friends));
    const uniqueRecent=[...new Map(recent.filter(item=>item.finishedAt).sort((a,b)=>new Date(b.finishedAt)-new Date(a.finishedAt)).map(item=>[item.id,item])).values()].slice(0,28);
    return {state,active,queued,recent:uniqueRecent};
  }

  function ensureDialog(){
    if(dialog)return dialog;
    dialog=document.createElement('dialog');dialog.className='small-dialog activity-dialog';
    dialog.innerHTML='<div class="dialog-head"><h3>Activity</h3><button class="icon" data-activity-close>×</button></div><div class="activity-dialog-body" data-activity-body></div>';
    document.body.append(dialog);
    dialog.querySelector('[data-activity-close]').onclick=()=>dialog.close();
    dialog.addEventListener('close',()=>{button.classList.remove('active');schedule(0);});
    dialog.addEventListener('click',handleAction);
    return dialog;
  }

  function row(item,recent=false){
    const p=item.progress?progress(item):{percent:item.percent??null,details:item.detail||'',current:'',indeterminate:true};
    if(item.detail&&!p.details)p.details=item.detail;
    const when=item.status==='running'?item.startedAt:item.status==='queued'?item.queuedAt:item.finishedAt;
    const statusClass=item.status==='error'?'error':item.status==='running'?'running':'';
    const detailClass=item.status==='error'?'activity-error-text':item.detail?.includes('Waiting')?'activity-wait':'';
    const cancel=item.cancelable&&!recent?`<button class="activity-cancel" data-activity-cancel="${esc(item.id)}">Cancel</button>`:'';
    const progressHtml=!recent&&item.status==='running'?`<div class="activity-progress ${p.indeterminate?'indeterminate':''}"><i style="width:${p.indeterminate?'32%':`${Math.max(1,Math.min(100,item.percent??p.percent??0))}%`}"></i></div>`:'';
    const detail=[p.details,item.error].filter(Boolean).join(' · ');
    return `<div class="activity-row ${statusClass}" data-activity-id="${esc(item.id)}"><div class="activity-main"><div class="activity-title"><span class="activity-kind">${esc(item.kind||'Work')}</span><span>${esc(item.title||'Working')}</span></div>${detail?`<div class="activity-detail ${detailClass}">${esc(detail)}</div>`:''}${p.current?`<span class="activity-current" title="${esc(p.current)}">${esc(p.current)}</span>`:''}${progressHtml}</div><div class="activity-side">${when?`<time title="${esc(new Date(when).toLocaleString())}">${esc(age(when))}</time>`:''}${cancel}</div></div>`;
  }

  function render(model){
    lastModel=model;
    const active=model.active.length,queued=model.queued.length,errors=model.recent.filter(item=>item.status==='error'&&Date.now()-new Date(item.finishedAt).getTime()<24*60*60*1000).length;
    button.classList.toggle('working',active>0);button.classList.toggle('issue',!active&&errors>0);button.querySelector('.activity-count').textContent=active||queued?`${active?`${active} working`:''}${active&&queued?' · ':''}${queued?`${queued} queued`:''}`:'';
    button.title=active||queued?`${active} working · ${queued} queued`:'Activity';
    if(!dialog?.open)return;
    const body=dialog.querySelector('[data-activity-body]');
    body.innerHTML=`<div class="activity-summary"><strong>${active?`${active} working`:queued?'Ready to work':'All caught up'}</strong>${queued?`<span>· ${queued} queued</span>`:''}<span class="spacer"></span><span>${esc(model.state?.background?.waiting?'Waiting for idle':model.state?.settings?.thumbnailMode==='off'?'Background paused':'')}</span></div>${active?`<section class="activity-section"><div class="activity-section-head">Now <b>${active}</b></div><div class="activity-list">${model.active.map(item=>row(item)).join('')}</div></section>`:''}${queued?`<section class="activity-section"><div class="activity-section-head">Next <b>${queued}</b></div><div class="activity-list">${model.queued.map(item=>row(item)).join('')}</div></section>`:''}<section class="activity-section activity-recent"><div class="activity-section-head">Recently <b>${model.recent.length}</b></div>${model.recent.length?`<div class="activity-list">${model.recent.map(item=>row(item,true)).join('')}</div>`:'<div class="activity-empty">Nothing recent.</div>'}</section>`;
  }

  async function handleAction(event){
    const cancel=event.target.closest('[data-activity-cancel]');if(!cancel)return;
    const item=[...(lastModel?.active||[]),...(lastModel?.queued||[])].find(entry=>entry.id===cancel.dataset.activityCancel);if(!item)return;
    cancel.disabled=true;
    try{
      if(item.source==='squish')await request(`/api/work/${item.rawId}/cancel`,{method:'POST'});
      else if(item.source==='squish-batch')await Promise.allSettled(item.rawIds.map(id=>request(`/api/work/${id}/cancel`,{method:'POST'})));
      else if(item.source==='agent-queue')await request('/api/job/cancel',{method:'POST',body:{id:item.id}});
      else await request('/api/job/cancel',{method:'POST'});
      schedule(0);
    }catch(error){toast(error.message);cancel.disabled=false;}
  }

  async function refresh(){
    clearTimeout(timer);timer=0;if(busy||document.hidden)return schedule(2500);busy=true;
    try{
      const results=await Promise.allSettled([request('/api/state'),request('/api/folder-stats'),request('/api/work'),request(`${FRIEND_ORIGIN}/local/friend-backups`)]);
      const state=results[0].status==='fulfilled'?results[0].value:null;
      if(!state)throw results[0].reason||new Error('Activity unavailable');
      const stats=results[1].status==='fulfilled'?results[1].value:{folders:[]};
      const work=results[2].status==='fulfilled'?results[2].value:{jobs:[]};
      const friends=results[3].status==='fulfilled'?results[3].value:{backups:[]};
      render(buildModel(state,stats,work,friends));
    }catch(error){button.title=error.message;}
    finally{busy=false;schedule(dialog?.open||lastModel?.active?.length?900:3500);}
  }
  function schedule(delay=0){clearTimeout(timer);timer=setTimeout(refresh,Math.max(0,delay));}
  button.onclick=()=>{const box=ensureDialog();button.classList.add('active');if(!box.open)box.showModal();render(lastModel||{state:null,active:[],queued:[],recent:savedRecent()});schedule(0);};
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)schedule(0);});
  window.addEventListener('focus',()=>schedule(0));
  schedule(120);
}
