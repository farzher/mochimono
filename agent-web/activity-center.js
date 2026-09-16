import './navigation-ux.js';

const host = document.querySelector('.client-head-actions');
const toastNode = document.querySelector('#toast');
const frame = document.querySelector('#filesFrame');

if (host) {
  const RECENT_KEY = 'mochimono.activity.recent.v1';
  const MAX_RECENT = 32;
  const MODE_LABEL = { off:'On demand', idle:'Idle', max:'Max' };
  let dialog = null;
  let button = null;
  let timer = 0;
  let busy = false;
  let lastModel = null;
  let attachedFrameWindow = null;
  const browserSyncs = new Map();
  const browserNames = new Map();

  const style = document.createElement('style');
  style.textContent = `
    .activity-button{height:31px;display:flex;align-items:center;gap:7px;padding:0 9px;border:1px solid transparent;border-radius:8px;background:transparent;color:#8d8584;font-size:10px;font-weight:700;white-space:nowrap}
    .activity-button:hover,.activity-button.active{border-color:#2d292d;background:#211e22;color:#eee7e3}.activity-dot{width:6px;height:6px;border-radius:50%;background:#696164}.activity-button.working .activity-dot{background:#e99b95;animation:activity-pulse .9s ease-in-out infinite}.activity-button.issue .activity-dot{background:#d3a067}.activity-count{color:#d8cfcb;font-variant-numeric:tabular-nums}
    .activity-dialog{width:min(700px,calc(100vw - 24px));max-height:min(820px,calc(100dvh - 24px));padding:0;overflow:hidden}.activity-dialog .dialog-head{padding:14px 16px 11px;border-bottom:1px solid #292529}.activity-body{max-height:calc(min(820px,100dvh - 24px) - 58px);overflow:auto;padding:13px 16px 17px}
    .activity-mode{display:flex;align-items:center;gap:10px;padding:10px 11px;margin-bottom:14px;border:1px solid #292529;border-radius:10px;background:#111012}.activity-mode-copy{min-width:0;flex:1}.activity-mode-copy strong{display:block;color:#d9d0cc;font-size:11px}.activity-mode-copy span{display:block;margin-top:2px;color:#77706e;font-size:9px}.activity-mode-buttons{display:flex;gap:2px;padding:2px;border-radius:7px;background:#1d1a1e}.activity-mode-buttons button{height:25px;padding:0 8px;border:0;border-radius:5px;background:transparent;color:#817977;font-size:9px;font-weight:700}.activity-mode-buttons button:hover{color:#ddd4d0}.activity-mode-buttons button.active{background:#302b30;color:#f0e8e4}
    .activity-summary{display:flex;align-items:center;gap:7px;margin-bottom:10px;color:#89817e;font-size:10px}.activity-summary strong{color:#d9d0cc;font-size:12px}.activity-summary .spacer{flex:1}.activity-waiting{color:#aa9588}
    .activity-section{margin-top:15px}.activity-section:first-of-type{margin-top:0}.activity-section-head{display:flex;align-items:baseline;gap:7px;margin:0 0 7px;color:#77706e;font-size:9px;font-weight:720;text-transform:uppercase;letter-spacing:.055em}.activity-section-head b{color:#99908d}.activity-list{display:grid;gap:6px}
    .activity-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;padding:10px 11px;border:1px solid #292529;border-radius:10px;background:#111012}.activity-row.running{border-color:#3b3032;background:#151113}.activity-row.error{border-color:#442d31}.activity-main{min-width:0}.activity-title{display:flex;align-items:center;gap:7px;color:#d8cfcb;font-size:11px;font-weight:710}.activity-kind{flex:0 0 auto;padding:2px 5px;border-radius:99px;background:#282329;color:#928987;font-size:8px;font-weight:750;text-transform:uppercase;letter-spacing:.04em}.activity-title span:last-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.activity-detail{margin-top:4px;color:#817976;font-size:9.5px;line-height:1.4}.activity-detail.wait{color:#aa9588}.activity-current{display:block;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#6f6968;font:9px ui-monospace,SFMono-Regular,Consolas,monospace}
    .activity-progress{height:4px;margin-top:7px;overflow:hidden;border-radius:99px;background:#292529}.activity-progress i{display:block;height:100%;min-width:2px;border-radius:inherit;background:#e99b95;transition:width .3s ease}.activity-progress.indeterminate i{width:30%;animation:activity-slide 1.3s ease-in-out infinite}.activity-side{display:flex;align-items:start;gap:7px;color:#756e6c;font-size:9px;white-space:nowrap}.activity-side time{padding-top:4px}.activity-cancel{border:0;background:transparent;color:#918784;padding:3px 4px;font-size:9px;font-weight:700}.activity-cancel:hover{color:#e2d8d4}.activity-empty{padding:15px 10px;color:#77706e;text-align:center;font-size:10px}.activity-recent .activity-row{padding-top:8px;padding-bottom:8px;background:#0f0e10}
    @keyframes activity-pulse{0%,100%{transform:scale(.72);opacity:.55}50%{transform:scale(1.2);opacity:1}}@keyframes activity-slide{0%{transform:translateX(-115%)}50%{transform:translateX(105%)}100%{transform:translateX(315%)}}
    @media(max-width:700px){.activity-button{padding:0 7px}.activity-button .activity-label{display:none}.activity-mode{align-items:flex-start;flex-direction:column}.activity-mode-buttons{width:100%}.activity-mode-buttons button{flex:1}.activity-row{grid-template-columns:1fr}.activity-side{justify-content:flex-end}.activity-body{padding-left:11px;padding-right:11px}}
    @media(prefers-reduced-motion:reduce){.activity-dot,.activity-progress i{animation:none!important;transition:none!important}}
  `;
  document.head.append(style);

  // Background mode belongs in Activity now; remove the old standalone header control.
  document.querySelector('.preview-mode-row')?.remove();

  button = document.createElement('button');
  button.type = 'button';
  button.className = 'activity-button';
  button.innerHTML = '<i class="activity-dot"></i><span class="activity-label">Activity</span><b class="activity-count"></b>';
  const menu = host.querySelector('.client-menu');
  menu?.before(button);
  if (!menu) host.append(button);

  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[char]));
  const baseName = value => String(value || '').replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).at(-1) || String(value || '');
  const clampPercent = value => Math.max(0, Math.min(100, Number(value) || 0));

  function bytes(number) {
    const units=['B','KB','MB','GB','TB','PB'];
    let value=Math.max(0,Number(number)||0), unit=0;
    while(value>=1000&&unit<units.length-1){value/=1000;unit++;}
    return `${value<10&&unit?value.toFixed(1):Math.round(value)} ${units[unit]}`;
  }
  function age(value) {
    const time=new Date(value||0).getTime(); if(!time)return '';
    const seconds=Math.max(0,Math.floor((Date.now()-time)/1000));
    if(seconds<60)return seconds<8?'just now':`${seconds}s ago`;
    const minutes=Math.floor(seconds/60); if(minutes<60)return `${minutes}m ago`;
    const hours=Math.floor(minutes/60); if(hours<48)return `${hours}h ago`;
    return `${Math.floor(hours/24)}d ago`;
  }
  function duration(seconds){seconds=Math.max(0,Math.round(Number(seconds)||0));if(seconds<60)return `${seconds}s`;const m=Math.floor(seconds/60);if(m<60)return `${m}m`;return `${Math.floor(m/60)}h ${m%60}m`;}
  function toast(text){if(!toastNode)return;toastNode.textContent=text;toastNode.classList.add('show');clearTimeout(toastNode.timer);toastNode.timer=setTimeout(()=>toastNode.classList.remove('show'),2800);}

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
    const totalBytes=Number(p.totalBytes)||0;
    const doneBytes=Math.min(totalBytes,Number(p.doneBytes)||Number(p.copiedBytes)||0);
    const total=Number(p.total)||0;
    const checked=Number(p.checked??p.hashed??p.scanned)||0;
    const percent=totalBytes?doneBytes/totalBytes*100:total?checked/total*100:null;
    const details=[];
    if(p.phase)details.push(p.phase);
    if(totalBytes)details.push(`${bytes(doneBytes)} / ${bytes(totalBytes)}`);
    else if(total)details.push(`${checked.toLocaleString()} / ${total.toLocaleString()} files`);
    else if(p.scanned!=null)details.push(`${Number(p.scanned).toLocaleString()} files`);
    if(p.copied!=null)details.push(`${Number(p.copied).toLocaleString()} copied`);
    if(p.speedBps>0)details.push(`${bytes(p.speedBps)}/s`);
    if(p.etaSeconds>0)details.push(`${duration(p.etaSeconds)} left`);
    return {percent,details:details.join(' · '),current:p.current||'',indeterminate:Boolean(p.indeterminate)||percent==null};
  }

  function jobItem(item, source, cancelable=false){
    const op=operation(item);
    return {...item,source,kind:op.kind,title:op.title,cancelable};
  }

  function folderWorkItems(state, stats){
    const currentPath=String(state?.job?.progress?.path||'').toLowerCase();
    const active=[],queued=[],recent=[];
    for(const folder of stats?.folders||[]){
      const path=String(folder.path||'');
      const key=path.toLowerCase();
      const name=baseName(path)||path||'Folder';
      const diagnostics=folder.diagnostics||{};
      const globalHere=currentPath&&key===currentPath;
      if(diagnostics.running&&!globalHere){
        const hashing=diagnostics.jobType==='hash'||folder.hashing;
        const done=Number(diagnostics.hashProcessed)||0;
        const total=Number(diagnostics.hashTotal)||0;
        active.push({
          id:`folder:${key}`,source:'folder',kind:hashing?'Hash':'Index',title:name,status:'running',
          detail:total?`${done.toLocaleString()} / ${total.toLocaleString()} files`:`${Number(folder.files||0).toLocaleString()} files found`,
          percent:total?done/total*100:null,progress:{phase:hashing?'Hashing files':'Indexing files',indeterminate:!total},cancelable:false
        });
      } else if(folder.pending&&!globalHere){
        queued.push({id:`folder:${key}`,source:'folder',kind:folder.protected===false?'Index':'Sync',title:name,status:'queued',detail:folder.waitingForIdle?'Waiting for idle':'Waiting to scan',cancelable:false});
      }
      if(folder.hashPending>0&&!folder.hashing){
        queued.push({id:`hash:${key}`,source:'folder',kind:'Hash',title:name,status:'queued',detail:`${Number(folder.hashPending).toLocaleString()} files${folder.hashWaiting?' · waiting for idle':''}`,cancelable:false});
      }
      if(folder.lastIndexed) recent.push({id:`recent-index:${key}:${folder.lastIndexed}`,source:'folder',kind:'Index',title:name,status:'done',finishedAt:folder.lastIndexed,detail:`${Number(folder.files||0).toLocaleString()} files indexed`});
    }
    return {active,queued,recent};
  }

  function thumbnailItems(state, stats){
    const active=[],queued=[];
    for(const folder of stats?.folders||[]){
      if(!folder.previewWarming&&!folder.previewQueueActive&&!folder.previewQueueBackground)continue;
      const name=baseName(folder.path)||folder.path||'Folder';
      const total=Number(folder.previewTotal)||0;
      const phase=String(folder.previewPhase||'generating');
      const checking=phase==='checking';
      const ready=Math.min(total||Infinity,(Number(folder.previewReady)||0)+(Number(folder.previewGenerated)||0));
      const done=checking?(Number(folder.previewProcessed)||0):ready;
      const ownerActive=Number(folder.previewQueueActive)||0;
      const waiting=Boolean(folder.previewWaiting);
      const details=[];
      if(total) details.push(`${Math.min(done,total).toLocaleString()} / ${total.toLocaleString()} ${checking?'checked':'ready'}`);
      else if(done) details.push(`${done.toLocaleString()} ${checking?'checked':'ready'}`);
      if(ownerActive) details.push(`${ownerActive} generating`);
      if(folder.previewQueueBackground) details.push(`${Number(folder.previewQueueBackground).toLocaleString()} queued`);
      if(folder.previewFailed) details.push(`${Number(folder.previewFailed).toLocaleString()} failed`);
      if(waiting) details.push('waiting for idle');
      const item={
        id:`thumbs:${String(folder.path||'').toLowerCase()}`,source:'preview',kind:'Thumbnail',title:name,
        status:ownerActive?'running':'queued',detail:details.join(' · '),
        percent:total?done/total*100:null,progress:{phase:checking?'Checking thumbnails':waiting?'Waiting for idle':'Generating thumbnails',indeterminate:!total},cancelable:false
      };
      (ownerActive?active:queued).push(item);
    }

    const previews=state?.previews||{};
    const mainActive=Number(previews.active)||0;
    const mainQueued=(Number(previews.urgent)||0)+(Number(previews.priority)||0)+(Number(previews.queued)||0);
    if(mainActive||mainQueued){
      const waiting=state?.settings?.thumbnailMode==='off'?'On demand':previews.waitingForIdle?'Waiting for idle':'';
      const detail=[mainActive?`${mainActive} generating`:'',mainQueued?`${mainQueued.toLocaleString()} waiting`:'',waiting].filter(Boolean).join(' · ');
      const item={id:'thumbs:library',source:'preview',kind:'Thumbnail',title:'Library',status:mainActive?'running':'queued',detail,progress:{phase:waiting||'Generating thumbnails',indeterminate:true},cancelable:false};
      (mainActive?active:queued).push(item);
    }
    return {active,queued};
  }

  function browserItems(){
    const active=[];
    for(const item of browserSyncs.values()){
      const name=browserNames.get(item.id)||item.name||'Browser folder';
      const scanned=Number(item.scanned)||0;
      const transferred=Number(item.transferred)||0;
      const skipped=Number(item.skipped)||0;
      active.push({
        id:`browser:${item.id}`,source:'browser',kind:'Index',title:name,status:'running',
        detail:[`${scanned.toLocaleString()} files processed`,transferred?`${transferred.toLocaleString()} new/changed`:'',skipped?`${skipped.toLocaleString()} unchanged`:''].filter(Boolean).join(' · '),
        progress:{phase:'Indexing + thumbnails',indeterminate:true},cancelable:false
      });
    }
    return active;
  }

  function squishItems(work){
    const jobs=work?.jobs||[],active=[],queued=[],recent=[];
    for(const item of jobs.filter(item=>item.status==='running'))active.push({id:`squish:${item.id}`,rawId:item.id,source:'squish',kind:'Squish',title:item.filename||item.originalHash?.slice(0,12)||'Media',status:'running',startedAt:item.startedAt,progress:{phase:item.message||'Squishing',indeterminate:item.progress<=0},percent:Number(item.progress)||0,cancelable:true});
    const waiting=jobs.filter(item=>item.status==='queued');
    if(waiting.length) queued.push({id:'squish:queued',source:'squish-batch',rawIds:waiting.map(item=>item.id),kind:'Squish',title:`${waiting.length.toLocaleString()} files`,status:'queued',detail:'Waiting to squish',cancelable:true});
    for(const item of jobs.filter(item=>['done','error','canceled'].includes(item.status)).slice(0,12))recent.push({id:`squish:${item.id}`,source:'squish',kind:'Squish',title:item.filename||'Media',status:item.status,finishedAt:item.finishedAt,error:item.status==='error'?item.message:'',detail:item.status==='done'?'Squished':''});
    return {active,queued,recent};
  }

  function buildModel(state,stats,work){
    rememberAgent(state?.job);
    const active=[],queued=[],recent=[];
    if(state?.job?.status==='running')active.push(jobItem(state.job,'agent',true));
    for(const item of state?.job?.queue||[])queued.push(jobItem(item,'agent-queue',false));
    const folders=folderWorkItems(state,stats);
    const thumbs=thumbnailItems(state,stats);
    const squish=squishItems(work);
    active.push(...folders.active,...thumbs.active,...browserItems(),...squish.active);
    queued.push(...folders.queued,...thumbs.queued,...squish.queued);
    const backendRecent=(state?.job?.recent||[]).map(item=>jobItem(item,'agent-history',false));
    const browserRecent=savedRecent().map(item=>jobItem(item,'agent-history',false));
    recent.push(...backendRecent,...browserRecent,...folders.recent,...squish.recent);
    const uniqueRecent=[...new Map(recent.filter(item=>item.finishedAt).sort((a,b)=>new Date(b.finishedAt)-new Date(a.finishedAt)).map(item=>[item.id,item])).values()].slice(0,24);
    return {state,active,queued,recent:uniqueRecent};
  }

  function ensureDialog(){
    if(dialog)return dialog;
    dialog=document.createElement('dialog');
    dialog.className='small-dialog activity-dialog';
    dialog.innerHTML='<div class="dialog-head"><h3>Activity</h3><button class="icon" data-close>×</button></div><div class="activity-body" data-body></div>';
    document.body.append(dialog);
    dialog.querySelector('[data-close]').onclick=()=>dialog.close();
    dialog.addEventListener('close',()=>{button.classList.remove('active');schedule(0);});
    dialog.addEventListener('click',handleAction);
    return dialog;
  }

  function row(item,recent=false){
    const p=item.progress?progress(item):{percent:item.percent??null,details:item.detail||'',current:'',indeterminate:item.percent==null};
    if(item.detail)p.details=item.detail;
    const when=item.status==='running'?item.startedAt:item.status==='queued'?item.queuedAt:item.finishedAt;
    const statusClass=item.status==='error'?'error':item.status==='running'?'running':'';
    const detailClass=/waiting for idle|on demand/i.test(p.details)?'wait':'';
    const cancel=item.cancelable&&!recent?`<button class="activity-cancel" data-cancel="${esc(item.id)}">Cancel</button>`:'';
    const percent=item.percent??p.percent;
    const indeterminate=item.progress?.indeterminate??p.indeterminate;
    const progressHtml=!recent&&item.status==='running'?`<div class="activity-progress ${indeterminate?'indeterminate':''}"><i style="width:${indeterminate?'30%':`${Math.max(1,clampPercent(percent))}%`}"></i></div>`:'';
    const detail=[p.details,item.error].filter(Boolean).join(' · ');
    return `<div class="activity-row ${statusClass}"><div class="activity-main"><div class="activity-title"><span class="activity-kind">${esc(item.kind||'Work')}</span><span>${esc(item.title||'Working')}</span></div>${detail?`<div class="activity-detail ${detailClass}">${esc(detail)}</div>`:''}${p.current?`<span class="activity-current">${esc(p.current)}</span>`:''}${progressHtml}</div><div class="activity-side">${when?`<time>${esc(age(when))}</time>`:''}${cancel}</div></div>`;
  }

  function modeDescription(state){
    const mode=state?.settings?.thumbnailMode||'idle';
    if(mode==='off')return 'Only run expensive work when you ask';
    if(mode==='max')return 'Finish pending background work now';
    return state?.background?.allowed?'Computer is idle · background work can run':'Waiting until the computer is idle';
  }

  function render(model){
    lastModel=model;
    const active=model.active.length, queued=model.queued.length;
    const errors=model.recent.filter(item=>item.status==='error'&&Date.now()-new Date(item.finishedAt).getTime()<86400000).length;
    button.classList.toggle('working',active>0);
    button.classList.toggle('issue',!active&&errors>0);
    button.querySelector('.activity-count').textContent=active||queued?`${active?`${active} working`:''}${active&&queued?' · ':''}${queued?`${queued} waiting`:''}`:'';
    button.title=active||queued?`${active} working · ${queued} waiting`:'Activity';
    window.dispatchEvent(new CustomEvent('mochimono:background-state',{detail:{mode:model.state?.settings?.thumbnailMode||'idle',allowed:Boolean(model.state?.background?.allowed)}}));
    if(!dialog?.open)return;
    const mode=model.state?.settings?.thumbnailMode||'idle';
    const body=dialog.querySelector('[data-body]');
    body.innerHTML=`
      <div class="activity-mode">
        <div class="activity-mode-copy"><strong>Background work · ${esc(MODE_LABEL[mode]||'Idle')}</strong><span>${esc(modeDescription(model.state))}</span></div>
        <div class="activity-mode-buttons" role="group" aria-label="Background work">
          ${['off','idle','max'].map(value=>`<button type="button" data-mode="${value}" class="${mode===value?'active':''}" title="${value==='off'?'Only run expensive work when asked':value==='idle'?'Run when this computer is idle':'Run pending background work immediately'}">${esc(MODE_LABEL[value])}</button>`).join('')}
        </div>
      </div>
      <div class="activity-summary"><strong>${active?`${active} working`:queued?`${queued} waiting`:'All caught up'}</strong>${active&&queued?`<span>· ${queued} waiting</span>`:''}<span class="spacer"></span>${mode==='idle'&&!model.state?.background?.allowed&&queued?'<span class="activity-waiting">Waiting for idle</span>':''}</div>
      ${active?`<section class="activity-section"><div class="activity-section-head">Now <b>${active}</b></div><div class="activity-list">${model.active.map(item=>row(item)).join('')}</div></section>`:''}
      ${queued?`<section class="activity-section"><div class="activity-section-head">Next <b>${queued}</b></div><div class="activity-list">${model.queued.map(item=>row(item)).join('')}</div></section>`:''}
      <section class="activity-section activity-recent"><div class="activity-section-head">Recently <b>${model.recent.length}</b></div>${model.recent.length?`<div class="activity-list">${model.recent.map(item=>row(item,true)).join('')}</div>`:'<div class="activity-empty">Nothing recent.</div>'}</section>`;
  }

  async function setMode(mode){
    if(!['off','idle','max'].includes(mode))return;
    try{
      await request('/api/settings',{method:'POST',body:{thumbnailMode:mode}});
      schedule(0);
    }catch(error){toast(error.message);}
  }

  async function handleAction(event){
    const modeButton=event.target.closest('[data-mode]');
    if(modeButton){
      const buttons=[...dialog.querySelectorAll('[data-mode]')];
      buttons.forEach(item=>item.disabled=true);
      await setMode(modeButton.dataset.mode);
      buttons.forEach(item=>item.disabled=false);
      return;
    }
    const cancel=event.target.closest('[data-cancel]');
    if(!cancel)return;
    const item=[...(lastModel?.active||[]),...(lastModel?.queued||[])].find(entry=>entry.id===cancel.dataset.cancel);
    if(!item)return;
    cancel.disabled=true;
    try{
      if(item.source==='squish')await request(`/api/work/${item.rawId}/cancel`,{method:'POST'});
      else if(item.source==='squish-batch')await Promise.allSettled(item.rawIds.map(id=>request(`/api/work/${id}/cancel`,{method:'POST'})));
      else await request('/api/job/cancel',{method:'POST'});
      schedule(0);
    }catch(error){toast(error.message);cancel.disabled=false;}
  }

  function attachBrowserFolderEvents(){
    const child=frame?.contentWindow;
    if(!child||child===attachedFrameWindow)return;
    attachedFrameWindow=child;
    child.addEventListener('mochimono:browser-folder-sync',event=>{
      const detail=event.detail||{};
      const id=String(detail.id||'');
      if(!id)return;
      if(detail.state==='running')browserSyncs.set(id,{...detail,id});
      else browserSyncs.delete(id);
      schedule(0);
    });
    child.mochimonoBrowserFolders?.list?.().then(items=>{
      for(const item of items||[])browserNames.set(String(item.id),String(item.name||'Browser folder'));
      schedule(0);
    }).catch?.(()=>{});
  }
  frame?.addEventListener('load',()=>setTimeout(attachBrowserFolderEvents,50));
  attachBrowserFolderEvents();

  async function refresh(){
    clearTimeout(timer);timer=0;
    if(busy||document.hidden)return schedule(2200);
    busy=true;
    try{
      attachBrowserFolderEvents();
      const wantsWork=Boolean(frame?.getAttribute('src'));
      const requests=[request('/api/state'),request('/api/folder-stats')];
      if(wantsWork)requests.push(request('/api/work'));
      const results=await Promise.allSettled(requests);
      const state=results[0].status==='fulfilled'?results[0].value:null;
      if(!state)throw results[0].reason||new Error('Activity unavailable');
      const stats=results[1].status==='fulfilled'?results[1].value:{folders:[]};
      const work=wantsWork&&results[2]?.status==='fulfilled'?results[2].value:{jobs:[]};
      render(buildModel(state,stats,work));
    }catch(error){button.title=error.message;}
    finally{busy=false;schedule(dialog?.open||lastModel?.active?.length?800:3000);}
  }

  function schedule(delay=0){clearTimeout(timer);timer=setTimeout(refresh,Math.max(0,delay));}
  button.onclick=()=>{const box=ensureDialog();button.classList.add('active');if(!box.open)box.showModal();render(lastModel||{state:{settings:{thumbnailMode:'idle'}},active:[],queued:[],recent:savedRecent()});schedule(0);};
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)schedule(0);});
  window.addEventListener('focus',()=>schedule(0));
  schedule(100);
}
