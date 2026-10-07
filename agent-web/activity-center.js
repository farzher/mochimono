import './navigation-ux.js';
import './thumbnail-failures.js';

const host = document.querySelector('.client-head-actions');
const toastNode = document.querySelector('#toast');
const frame = document.querySelector('#filesFrame');

if (host) {
  const RECENT_KEY = 'mochimono.activity.recent';
  const RECENT_OPEN_KEY = 'mochimono.activity.recent.open';
  let dialog = null;
  let button = null;
  let timer = 0;
  let busy = false;
  let lastModel = null;
  let lastRefreshAt = 0;
  let interactionUntil = 0;
  let recentOpen = sessionStorage.getItem(RECENT_OPEN_KEY) === '1';
  let frameGeneration = 0;
  let attachedGeneration = -1;
  const browserSyncs = new Map();
  const browserNames = new Map();

  const style = document.createElement('style');
  style.textContent = `
    .activity-button{--activity-progress:0%;height:32px;display:flex;align-items:center;gap:7px;padding:0 10px;border:1px solid transparent;border-radius:9px;background:transparent;color:#958c89;font-size:12px;font-weight:760;white-space:nowrap}
    .activity-button:hover,.activity-button.active{border-color:#322d31;background:#211e22;color:#f0e9e5}
    .activity-gauge{display:block;position:relative;width:17px;height:17px;flex:0 0 17px;border-radius:50%;background:#3a3538}
    .activity-gauge:after{content:'';position:absolute;inset:3px;border-radius:50%;background:#111012}
    .activity-button.working .activity-gauge{background:conic-gradient(#e99b95 var(--activity-progress),#3a3538 0)}
    .activity-button.working .activity-gauge.indeterminate{background:conic-gradient(#e99b95 0 24%,#3a3538 24% 100%);animation:activity-spin .9s linear infinite}
    .activity-button:not(.working) .activity-gauge{background:transparent}
    .activity-button:not(.working) .activity-gauge:after{inset:5px;background:#6d6668}
    .activity-button.waiting .activity-gauge:after,.activity-button.issue:not(.working) .activity-gauge:after{background:#d3a067;box-shadow:0 0 0 3px #d3a06718}
    .activity-count{color:#cfc3bf;font-size:11px;font-variant-numeric:tabular-nums}
    .activity-dialog{width:min(680px,calc(100vw - 24px));max-height:min(820px,calc(100dvh - 24px));padding:0;overflow:hidden}.activity-dialog .dialog-head{padding:17px 20px 14px;border-bottom:1px solid #292529}.activity-dialog .dialog-head h3{font-size:18px;font-weight:820;letter-spacing:-.02em}.activity-body{max-height:calc(min(820px,100dvh - 24px) - 60px);overflow:auto;overscroll-behavior:contain;padding:20px;scrollbar-gutter:stable}
    .activity-overview{display:grid;grid-template-columns:54px minmax(0,1fr);gap:14px;align-items:center;padding:16px 17px;border-radius:16px;background:#151316;box-shadow:inset 0 0 0 1px #2b272b}.activity-orb{width:50px;height:50px;display:grid;place-items:center;border-radius:15px;background:#211e22}.activity-orb i{width:15px;height:15px;border:3px solid #777073;border-radius:50%}.activity-overview.working .activity-orb{background:#281d20}.activity-overview.working .activity-orb i{border-color:#e99b95;border-right-color:transparent;animation:activity-spin 1s linear infinite}.activity-overview.waiting .activity-orb i{border:0;width:12px;height:12px;background:#b08c68;box-shadow:0 0 0 7px rgba(176,140,104,.1)}.activity-overview strong{display:block;color:#f1e9e5;font-size:22px;font-weight:820;letter-spacing:-.03em}.activity-overview span{display:block;margin-top:3px;color:#988f8b;font-size:13px;font-weight:620}
    .activity-section{margin-top:22px}.activity-section-head{display:flex;align-items:center;gap:8px;margin:0 2px 9px;color:#c7beba;font-size:13px;font-weight:800}.activity-section-head b{min-width:22px;padding:2px 6px;border-radius:999px;background:#211e22;color:#8f8783;font-size:10px;font-weight:760;text-align:center}.activity-list{display:grid;gap:8px}
    .activity-row{display:grid;grid-template-columns:42px minmax(0,1fr) auto;gap:12px;align-items:center;min-width:0;padding:12px 13px;border:0;border-radius:14px;background:#141214;box-shadow:inset 0 0 0 1px #272327}.activity-row.running{background:#181315;box-shadow:inset 3px 0 0 #d98f89,inset 0 0 0 1px #30272a}.activity-row.error{box-shadow:inset 3px 0 0 #bc6e76,inset 0 0 0 1px #38272b}.activity-task-icon{width:40px;height:40px;display:grid;place-items:center;border-radius:11px;background:#211e22;color:#b8afab}.activity-row.running .activity-task-icon{background:#2a2023;color:#e3aaa5}.activity-task-icon svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.activity-row-main{min-width:0}.activity-row-head{min-width:0}.activity-row-head strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e9e0dc;font-size:14.5px;font-weight:790;letter-spacing:-.012em}.activity-detail{margin-top:3px;white-space:normal;line-height:1.5;color:#958c88;font-size:11.5px;font-weight:560;font-variant-numeric:tabular-nums}.activity-progress{height:7px;margin-top:10px;overflow:hidden;border-radius:99px;background:#2a262a}.activity-progress i{display:block;height:100%;min-width:3px;border-radius:inherit;background:#df938d;transition:width .3s ease}.activity-progress.indeterminate i{width:34%;animation:activity-slide 1.25s ease-in-out infinite}.activity-side{display:flex;align-items:center;gap:7px;color:#8a817e;font-size:11px;font-weight:700;white-space:nowrap}.activity-percent{color:#cfc4c0;font-variant-numeric:tabular-nums}.activity-cancel{width:30px;height:30px;border:0;border-radius:8px;background:#211e22;color:#9c918d;padding:0;font-size:0}.activity-cancel:hover{background:#302b30;color:#f0e7e3}.activity-cancel:after{content:'×';font-size:17px}.activity-empty{padding:14px 2px;color:#827a77;font-size:12px}
    .activity-recent{margin-top:20px;padding-top:4px;border-top:1px solid #292529}.activity-recent .activity-list,.activity-recent .activity-empty{display:none}.activity-recent.open .activity-list,.activity-recent.open .activity-empty{display:grid}.activity-recent .activity-section-head{margin:0;padding:12px 2px 2px;cursor:pointer;user-select:none}.activity-recent .activity-section-head:hover{color:#eee5e1}.activity-recent .activity-section-head:after{content:'›';margin-left:auto;font-size:19px;color:#8f8582;transform:rotate(90deg);transition:transform .15s}.activity-recent.open .activity-section-head:after{transform:rotate(-90deg)}.activity-recent.open .activity-list,.activity-recent.open .activity-empty{margin-top:8px}.activity-recent .activity-row{grid-template-columns:34px minmax(0,1fr) auto;padding:9px 11px;border-radius:11px;background:#111012}.activity-recent .activity-task-icon{width:32px;height:32px;border-radius:9px}.activity-recent .activity-task-icon svg{width:18px;height:18px}.activity-recent .activity-row-head strong{font-size:13px}.activity-recent .activity-detail,.activity-recent .activity-progress{display:none}
    .activity-current{margin-top:6px;color:#736a69;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.activity-detail{font-variant-numeric:tabular-nums}.activity-row.running .activity-row-main{min-height:54px}.activity-overview.working strong{font-size:20px}
    @keyframes activity-pulse{0%,100%{transform:scale(.72);opacity:.55}50%{transform:scale(1.2);opacity:1}}@keyframes activity-spin{to{transform:rotate(360deg)}}@keyframes activity-slide{0%{transform:translateX(-115%)}50%{transform:translateX(105%)}100%{transform:translateX(315%)}}
    @media(max-width:700px){.activity-button{padding:0 7px}.activity-button .activity-label{display:none}.activity-count{font-size:0}.activity-count:after{content:attr(data-compact);font-size:11px}.activity-body{padding:14px}.activity-setting{align-items:stretch;flex-direction:column}.activity-mode-buttons{display:grid;grid-template-columns:repeat(3,1fr)}.activity-mode-buttons button{min-width:0}.activity-row{grid-template-columns:38px minmax(0,1fr) auto;padding:11px}.activity-task-icon{width:36px;height:36px}}
    @media(prefers-reduced-motion:reduce){.activity-gauge,.activity-progress i,.activity-orb i{animation:none!important;transition:none!important}}
  `;
  document.head.append(style);
  document.querySelector('.preview-mode-row')?.remove();

  button = document.createElement('button');
  button.type = 'button';
  button.className = 'activity-button';
  button.innerHTML = '<i class="activity-gauge" aria-hidden="true"></i><span class="activity-label">Activity</span><span class="activity-count"></span>';
  button.setAttribute('aria-haspopup','dialog');
  button.setAttribute('aria-expanded','false');
  const menu = host.querySelector('.client-menu');
  menu?.before(button);
  if (!menu) host.append(button);

  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[char]));
  const baseName = value => String(value || '').replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).at(-1) || String(value || '');
  const pct = value => Math.max(0, Math.min(100, Number(value) || 0));

  function bytes(number) {
    const units=['B','KB','MB','GB','TB','PB'];
    let value=Math.max(0,Number(number)||0), unit=0;
    while(value>=1000&&unit<units.length-1){value/=1000;unit++;}
    return `${value<10&&unit?value.toFixed(1):Math.round(value)} ${units[unit]}`;
  }
  function age(value) {
    const time=new Date(value||0).getTime(); if(!time)return '';
    const seconds=Math.max(0,Math.floor((Date.now()-time)/1000)); if(seconds<60)return seconds<8?'just now':`${seconds}s ago`;
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
  function saveRecent(items){try{localStorage.setItem(RECENT_KEY,JSON.stringify(items.slice(0,32)));}catch{}}
  function rememberAgent(job){
    if(!job?.id||job.status==='running'||job.status==='queued')return;
    const recent=savedRecent();
    if(recent.some(item=>item.id===job.id))return;
    recent.unshift({id:job.id,type:job.type,label:job.label,status:job.status,error:job.error||'',startedAt:job.startedAt||null,finishedAt:job.finishedAt||new Date().toISOString()});
    saveRecent(recent);
  }

  function operation(job){
    const label=String(job?.label||'');
    if(/^Friend /.test(label))return {kind:'Friend Drive',title:label.replace(/^Friend (update|verify|restore) /,(_,verb)=>`${verb[0].toUpperCase()+verb.slice(1)} · `)};
    if(job?.type==='hash')return {kind:'Hash',title:label.replace(/^Hash /,'')};
    if(job?.type==='sync'){
      const index=/^(Check|Update) /.test(label);
      return {kind:index?'Index':'Sync',title:label.replace(/^(Sync|Check|Update) /,'')};
    }
    if(job?.type==='protection')return {kind:'Backup',title:/^Automatic protection$/i.test(label)?'Protect files':label.replace(/^Update /,'')};
    if(job?.type==='backup')return {kind:'Backup',title:label.replace(/^Update /,'')};
    if(job?.type==='verify')return {kind:'Verify',title:label.replace(/^Verify /,'')};
    if(job?.type==='restore')return {kind:'Restore',title:label.replace(/^Restore /,'')};
    return {kind:'Work',title:label||job?.type||'Background work'};
  }
  function jobItem(job, source, cancelable=false){const op=operation(job);return {...job,source,kind:op.kind,title:op.title,cancelable};}

  function taskTitle(item){
    const title=String(item?.title||'').trim();
    const kind=String(item?.kind||'Work');
    if(!title)return kind;
    if(kind==='Thumbnail')return title==='Library'?'Thumbnails':`Thumbnails · ${title}`;
    if(kind==='Friend Drive')return title;
    if(kind==='Work')return title;
    return new RegExp(`^${kind}\\b`,'i').test(title)?title:`${kind} ${title}`;
  }

  function taskIcon(kind){
    if(kind==='Thumbnail')return '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>';
    if(kind==='Backup'||kind==='Friend Drive')return '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M6 14h12M7 9h10"/><circle cx="8" cy="14" r=".8"/></svg>';
    if(kind==='Verify')return '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m8 12 2.6 2.6L16.5 9"/></svg>';
    if(kind==='Restore')return '<svg viewBox="0 0 24 24"><path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M5 20h14"/></svg>';
    if(kind==='Squish')return '<svg viewBox="0 0 24 24"><path d="M8 3v5H3m13-5v5h5M8 21v-5H3m13 5v-5h5"/><path d="m8 8-4-4m12 4 4-4M8 16l-4 4m12-4 4 4"/></svg>';
    if(kind==='Index'||kind==='Sync'||kind==='Hash')return '<svg viewBox="0 0 24 24"><path d="M5 7h10M5 12h14M5 17h8"/><path d="m17 5 2 2-2 2"/></svg>';
    return '<svg viewBox="0 0 24 24"><circle cx="6" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="18" cy="12" r="1"/></svg>';
  }

  function compactDetail(item, detail){
    const text=String(item?.error||detail||'').trim();
    if(!text)return '';
    if(/waiting until your pc is idle/i.test(text))return 'Waiting for idle';
    const parts=text.split(' · ').map(part=>part.trim()).filter(Boolean);
    const phase=parts.find(part=>!/^\d/.test(part)&&!/\d+\s*(?:files?|ready|checked|generated|done|copied|queued|waiting|left|\/s|[KMGTP]?B)/i.test(part));
    const metric=parts.find(part=>/\d/.test(part)&&/(?:files?|ready|checked|generated|done|copied|queued|waiting|left|\/s|[KMGTP]?B)/i.test(part));
    return [phase,metric].filter(Boolean).slice(0,2).join(' · ')||parts[0]||text;
  }

  function progress(job){
    const p=job?.progress||{};
    const totalBytes=Number(p.totalBytes)||0;
    const doneBytes=Math.min(totalBytes,Number(p.doneBytes)||Number(p.copiedBytes)||0);
    const total=Number(p.total)||0;
    const checked=Number(p.checked??(p.phase==='Hashing content'?p.hashed:p.scanned)??p.hashed)||0;
    const percent=totalBytes?doneBytes/totalBytes*100:total?checked/total*100:null;
    const detail=[];
    if(p.phase)detail.push(p.phase);
    if(totalBytes)detail.push(`${bytes(doneBytes)} / ${bytes(totalBytes)}`);
    else if(total)detail.push(`${checked.toLocaleString()} / ${total.toLocaleString()} files`);
    else if(p.scanned!=null){
      detail.push(`${Number(p.scanned).toLocaleString()} ${p.phase==='Checking files'?'checked':'found'}`);
      if(p.reused>0)detail.push(`${Number(p.reused).toLocaleString()} unchanged`);
      if(p.added>0)detail.push(`${Number(p.added).toLocaleString()} new or changed`);
    }
    if(p.copied!=null)detail.push(`${Number(p.copied).toLocaleString()} copied`);
    if(p.speedBps>0)detail.push(`${bytes(p.speedBps)}/s`);
    const staleScan=p.scanned!=null&&p.updatedAt&&Date.now()-p.updatedAt>5000&&job.status==='running';
    if(staleScan)detail.push(`Last scan update ${duration((Date.now()-p.updatedAt)/1000)} ago`);
    else if(p.filesPerSecond>0)detail.push(`${Number(p.filesPerSecond).toLocaleString()} files/s`);
    if(p.elapsedSeconds>0)detail.push(duration(p.elapsedSeconds));
    if(p.etaSeconds>0)detail.push(`${duration(p.etaSeconds)} left`);
    return {percent,detail:detail.join(' · '),current:p.current||'',indeterminate:Boolean(p.indeterminate)||percent==null};
  }

  function folderItems(state, stats){
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
        const p=folder.progress||{};
        const done=Number(hashing ? p.hashed ?? diagnostics.hashProcessed : p.checked ?? p.scanned)||0;
        const total=Number(p.total)||0;
        active.push({
          id:`folder:${key}`,source:'folder',kind:hashing?'Hash':'Index',type:hashing?'hash':'sync',title:name,
          label:`${hashing?'Hash':'Index'} ${name}`,path,status:'running',cancelable:false,
          startedAt:folder.startedAt,
          percent:total&&!p.indeterminate?done/total*100:null,
          phase:p.phase||(hashing?'Hashing content':'Finding files'),
          progress:{...p,path,phase:p.phase||(hashing?'Hashing content':'Finding files'),total,indeterminate:p.indeterminate??!total}
        });
      } else if(folder.pending&&!globalHere){
        queued.push({id:`folder:${key}`,source:'folder',kind:folder.protected===false?'Index':'Sync',title:name,path,status:folder.available===false?'blocked':'queued',detail:folder.available===false?'Drive offline':folder.waitingForIdle?'Waiting until your PC is idle':'Waiting to start'});
      }
      if(folder.hashPending>0&&!folder.hashing)queued.push({id:`hash:${key}`,source:'folder',kind:'Hash',title:name,path,phase:folder.hashWaitReason||(folder.available===false?'Drive offline':folder.hashWaiting?'Waiting for idle':'Waiting to start'),remaining:Number(folder.hashPending),status:folder.available===false?'blocked':'queued',detail:`${Number(folder.hashPending).toLocaleString()} files · ${folder.hashWaitReason||(folder.available===false?'Drive offline':folder.hashWaiting?'Waiting until your PC is idle':'Waiting to start')}`});
      if(folder.lastIndexed)recent.push({id:`recent-index:${key}:${folder.lastIndexed}`,source:'folder',kind:'Index',title:name,status:'done',finishedAt:folder.lastIndexed,detail:`${Number(folder.files||0).toLocaleString()} files indexed`});
    }
    return {active,queued,recent};
  }

  function thumbnailItems(state, stats){
    const active=[],queued=[],issues=[];
    for(const folder of stats?.folders||[]){
      const hasFailures=folder.previewFailed>0||folder.previewDeferred>0;
      if(!folder.previewWarming&&!folder.previewQueueActive&&!folder.previewQueueBackground){
        if(folder.previewFailed>0)issues.push({id:`thumbs:${String(folder.path||'').toLowerCase()}`,source:'preview',kind:'Thumbnail',title:baseName(folder.path),path:folder.path,status:'done',detail:`Finished · ${Number(folder.previewReady||0).toLocaleString()} ready · ${Number(folder.previewFailed).toLocaleString()} unavailable`,thumbnailFailures:true});
        continue;
      }
      const name=baseName(folder.path)||folder.path||'Folder';
      const total=Number(folder.previewTotal)||0;
      const checking=['checking','discovering'].includes(folder.previewPhase);
      const activeCount=Number(folder.previewQueueActive)||0;
      const queuedCount=Number(folder.previewQueueBackground)||0;
      const generated=Number(folder.previewGenerated)||0;
      const verified=Number(folder.previewReady??folder.previewProcessed)||0;
      const waiting=Boolean(folder.previewWaiting);
      const driveBlocked=Boolean(folder.previewDriveBlocked);
      // Queue length is a bounded batch, never the size of the folder.
      const progressTotal=folder.previewTotalKnown?total:0;
      const done=verified;
      const unit='ready';
      const unavailable=folder.previewPhase==='unavailable'||folder.available===false;
      const blocked=folder.previewPhase==='waiting';
      const phase=unavailable?'Drive offline':blocked?'Waiting to retry':waiting?'Waiting for idle':driveBlocked?'Waiting for drive':activeCount||queuedCount?'Generating':checking?'Checking thumbnails':'Generating';
      const status=unavailable||blocked?'blocked':waiting||driveBlocked?'queued':'running';
      const detail=[phase];
      if(progressTotal)detail.push(`${Math.min(done,progressTotal).toLocaleString()} / ${progressTotal.toLocaleString()} ${unit}`);
      else {
        if(generated)detail.push(`${generated.toLocaleString()} generated`);
        if(verified)detail.push(`${verified.toLocaleString()} verified`);
      }
      if(activeCount)detail.push(`${activeCount} generating`);
      if(queuedCount)detail.push(`${queuedCount.toLocaleString()} queued`);
      if(folder.previewFailed)detail.push(`${Number(folder.previewFailed).toLocaleString()} failed`);
      const indeterminate=!progressTotal;
      const item={id:`thumbs:${String(folder.path||'').toLowerCase()}`,source:'preview',kind:'Thumbnail',type:'thumbnail',title:name,label:`Thumbnails ${name}`,path:folder.path,status,cancelable:false,detail:detail.join(' · '),percent:indeterminate?null:done/progressTotal*100,phase,thumbnailFailures:hasFailures,progress:{path:folder.path,phase,checked:done,total:progressTotal,unit,indeterminate}};
      (status==='running'?active:queued).push(item);
    }

    const previews=state?.previews||{};
    const scopedActive=(stats?.folders||[]).reduce((sum,folder)=>sum+(Number(folder.previewQueueActive)||0),0);
    const scopedWaiting=(stats?.folders||[]).reduce((sum,folder)=>sum+(Number(folder.previewQueueBackground)||0),0);
    const uploading=Number(previews.activeUploads)||0;
    const uploads=Number(previews.pendingUploads)||0;
    const activeCount=Math.max(0,(Number(previews.active)||0)-scopedActive-uploading);
    const waitingCount=Math.max(0,(Number(previews.urgent)||0)+(Number(previews.priority)||0)+(Number(previews.queued)||0)-scopedWaiting-(Number(previews.uploadQueued)||0));
    if(uploads){
      const offline=Boolean(previews.cloudWaiting);
      const item={id:'thumbs:upload',source:'preview',kind:'Thumbnail',title:'Cloud',status:offline?'blocked':uploading?'running':'queued',phase:offline?'Cloud offline':'Uploading thumbnails',detail:`${uploads.toLocaleString()} remaining`};
      (uploading?active:queued).push(item);
    }
    if(activeCount||waitingCount){
      const wait=previews.waitingForIdle?'Waiting until your PC is idle':'';
      const item={id:'thumbs:library',source:'preview',kind:'Thumbnail',title:'Library',status:activeCount?'running':'queued',detail:[activeCount?`${activeCount} generating`:'',waitingCount?`${waitingCount.toLocaleString()} waiting`:'',wait].filter(Boolean).join(' · '),phase:wait||'Generating thumbnails'};
      (activeCount?active:queued).push(item);
    }
    return {active,queued,issues};
  }

  function browserItems(){
    const active=[],queued=[];
    for(const item of browserSyncs.values()){
      const waiting=item.state==='queued';
      const entry={
        id:`browser:${item.id}`,source:'browser',kind:'Index',title:browserNames.get(item.id)||'Local folder',status:waiting?'queued':'running',
        detail:waiting?'Waiting to index':[`${Number(item.scanned||0).toLocaleString()} files processed`,item.current?String(item.current).split('/').at(-1):'',item.transferred?`${Number(item.transferred).toLocaleString()} new or changed`:'',item.skipped?`${Number(item.skipped).toLocaleString()} unchanged`:'' ].filter(Boolean).join(' · '),
        phase:waiting?'Waiting to index':'Indexing local files'
      };
      (waiting?queued:active).push(entry);
    }
    return {active,queued};
  }

  function squishItems(work){
    const jobs=work?.jobs||[],active=[],queued=[],recent=[];
    for(const item of jobs.filter(item=>item.status==='running'))active.push({id:`squish:${item.id}`,rawId:item.id,source:'squish',kind:'Squish',title:item.filename||item.originalHash?.slice(0,12)||'Media',status:'running',startedAt:item.startedAt,phase:item.message||'Squishing',percent:Number(item.progress)||0,cancelable:true});
    const waiting=jobs.filter(item=>item.status==='queued');
    if(waiting.length)queued.push({id:'squish:queued',source:'squish-batch',rawIds:waiting.map(item=>item.id),kind:'Squish',title:`${waiting.length.toLocaleString()} files`,status:'queued',detail:'Waiting to start',cancelable:true});
    for(const item of jobs.filter(item=>['done','error','canceled'].includes(item.status)).slice(0,12))recent.push({id:`squish:${item.id}`,source:'squish',kind:'Squish',title:item.filename||'Media',status:item.status,finishedAt:item.finishedAt,error:item.status==='error'?item.message:'',detail:item.status==='done'?'Squished':''});
    return {active,queued,recent};
  }

  function buildModel(state,stats,work){
    rememberAgent(state?.job);
    const active=[],queued=[],recent=[];
    if(state?.job?.status==='running')active.push(jobItem(state.job,'agent',true));
    for(const item of state?.job?.queue||[])queued.push(jobItem(item,'agent-queue'));
    const folders=folderItems(state,stats), thumbs=thumbnailItems(state,stats), browser=browserItems(), squish=squishItems(work);
    active.push(...folders.active,...thumbs.active,...browser.active,...squish.active);
    queued.push(...folders.queued,...thumbs.queued,...browser.queued,...squish.queued);
    recent.push(...(state?.job?.recent||[]).map(item=>jobItem(item,'history')),...savedRecent().map(item=>jobItem(item,'history')),...folders.recent,...squish.recent);
    const unique=[...new Map(recent.filter(item=>item.finishedAt).sort((a,b)=>new Date(b.finishedAt)-new Date(a.finishedAt)).map(item=>[item.id,item])).values()].slice(0,24);
    return {state,folders:stats?.folders || [],active,issues:thumbs.issues,queued:queued.filter(item=>item.status!=='blocked'),blocked:queued.filter(item=>item.status==='blocked'),recent:unique};
  }

  function markInteraction(){ interactionUntil=Date.now()+900; }

  function ensureDialog(){
    if(dialog)return dialog;
    dialog=document.createElement('dialog');
    dialog.className='small-dialog activity-dialog';
    dialog.innerHTML='<div class="dialog-head"><h3>Activity</h3><button class="icon" data-close>×</button></div><div class="activity-body" data-body></div>';
    document.body.append(dialog);
    const body=dialog.querySelector('[data-body]');
    body.innerHTML=`<div class="activity-overview"><div class="activity-orb" aria-hidden="true"><i></i></div><div><strong></strong><span></span></div></div>
      ${[['active','Now'],['queued','Waiting'],['blocked','Paused'],['issues','Unavailable thumbnails']].map(([key,label])=>`<section class="activity-section" data-section="${key}" hidden><div class="activity-section-head">${label} <b></b></div><div class="activity-list"></div></section>`).join('')}
      <section class="activity-section activity-recent" data-section="recent"><div class="activity-section-head" data-recent-toggle>Recent <b></b></div><div class="activity-list"></div><div class="activity-empty">Nothing recent</div></section>`;
    body.addEventListener('wheel',markInteraction,{passive:true});
    body.addEventListener('touchmove',markInteraction,{passive:true});
    body.addEventListener('scroll',markInteraction,{passive:true});
    dialog.querySelector('[data-close]').onclick=()=>dialog.close();
    dialog.addEventListener('close',()=>{button.classList.remove('active');button.setAttribute('aria-expanded','false');schedule(0);});
    dialog.addEventListener('click',handleAction,true);
    return dialog;
  }

  function row(item,recent=false){
    let percent=item.percent??null, detail=item.detail||'', indeterminate=percent==null;
    if(item.progress){const p=progress(item);percent=item.percent??p.percent;detail=item.detail||p.detail;indeterminate=p.indeterminate;}
    if(item.phase&&!detail)detail=item.phase;
    const when=item.status==='running'?item.startedAt:item.status==='queued'?item.queuedAt:item.finishedAt;
    const statusClass=item.status==='error'?'error':item.status==='running'?'running':'';
    const cancel=item.cancelable&&!recent?`<button class="activity-cancel" data-cancel="${esc(item.id)}" aria-label="Cancel"></button>`:'';
    const bar=!recent&&(item.status==='running'||!indeterminate)?`<div class="activity-progress ${indeterminate?'indeterminate':''}"><i style="width:${indeterminate?'34%':`${Math.max(1,pct(percent))}%`}"></i></div>`:'';
    const concise=item.progress||item.thumbnailFailures?detail:compactDetail(item,detail);
    const failures=item.thumbnailFailures?`<button class="secondary" data-preview-failures="${esc(item.path)}">View failures</button>`:'';
    const current=item.progress?.current||'';
    const sidePercent=!recent&&!indeterminate?`<span class="activity-percent">${Math.floor(pct(percent))}%</span>`:'';
    const sideTime=recent&&when?`<time>${esc(age(when))}</time>`:'';
    const kind=item.kind||'Work';
    return `<div class="activity-row ${statusClass}" data-activity-id="${esc(item.id)}"><div class="activity-task-icon" aria-hidden="true">${taskIcon(kind)}</div><div class="activity-row-main"><div class="activity-row-head"><strong>${esc(taskTitle(item))}</strong></div>${concise?`<div class="activity-detail">${esc(concise)}</div>`:''}${current&&!recent?`<div class="activity-current" title="${esc(current)}">${esc(current)}</div>`:''}${bar}</div><div class="activity-side">${sidePercent}${sideTime}${cancel}${failures}</div></div>`;
  }

  function overview(model){
    const active=model.active.length, queued=model.queued.length;
    if(active){const primary=model.active[0];return {className:'working',title:primary.progress?.phase||primary.phase||taskTitle(primary),detail:`${active} active${queued?` · ${queued} waiting`:''}`};}
    if(queued)return {className:'waiting',title:'Waiting',detail:`${queued} queued`};
    if(model.blocked?.length)return {className:'waiting',title:'Paused',detail:`${model.blocked.length} blocked`};
    const unavailable=(model.folders||[]).filter(folder=>!folder.previewWarming).reduce((sum,folder)=>sum+(Number(folder.previewFailed)||0),0);
    return {className:'',title:'Caught up',detail:unavailable?`${unavailable.toLocaleString()} thumbnails unavailable`:'Nothing running'};
  }

  function buttonProgress(model){
    if(model.active.length!==1)return null;
    const item=model.active[0];
    if(item.progress?.indeterminate)return {percent:0,indeterminate:true};
    if(item.percent!=null)return {percent:pct(item.percent),indeterminate:false};
    if(item.progress){
      const value=progress(item);
      if(value.percent!=null&&!value.indeterminate)return {percent:pct(value.percent),indeterminate:false};
    }
    return {percent:0,indeterminate:true};
  }

  function syncRows(section, items, recent=false){
    section.hidden=!recent&&!items.length;
    section.querySelector('.activity-section-head b').textContent=items.length;
    const list=section.querySelector('.activity-list');
    const existing=new Map([...list.children].map(node=>[node.dataset.activityId,node]));
    let previous=null;
    for(const item of items){
      const template=document.createElement('template');
      template.innerHTML=row(item,recent);
      const next=template.content.firstElementChild;
      let node=existing.get(item.id);
      if(node){
        existing.delete(item.id);
        node.className=next.className;
        node.querySelector('.activity-row-head strong').textContent=next.querySelector('.activity-row-head strong').textContent;
        const main=node.querySelector('.activity-row-main');
        for(const selector of ['.activity-detail','.activity-current']){
          const before=node.querySelector(selector),after=next.querySelector(selector);
          if(before&&after){before.textContent=after.textContent;before.title=after.title;}
          else if(after)main.insertBefore(after,main.querySelector('.activity-progress'));
          else before?.remove();
        }
        const bar=node.querySelector('.activity-progress'),nextBar=next.querySelector('.activity-progress');
        if(bar&&nextBar){bar.className=nextBar.className;bar.firstElementChild.style.width=nextBar.firstElementChild.style.width;}
        else if(nextBar)main.append(nextBar);
        else bar?.remove();
        const side=node.querySelector('.activity-side'),nextSide=next.querySelector('.activity-side');
        if(side.innerHTML!==nextSide.innerHTML)side.innerHTML=nextSide.innerHTML;
      }else node=next;
      const at=previous?previous.nextElementSibling:list.firstElementChild;
      if(node!==at)list.insertBefore(node,at);
      previous=node;
    }
    for(const node of existing.values())node.remove();
    const empty=section.querySelector('.activity-empty');
    if(empty)empty.hidden=Boolean(items.length);
  }

  function render(model){
    lastModel=model;
    const active=model.active.length, queued=model.queued.length, blocked=model.blocked?.length||0;
    const errors=model.recent.filter(item=>item.status==='error'&&Date.now()-new Date(item.finishedAt).getTime()<86400000).length;
    const issues=model.issues?.length||0;
    const compact=buttonProgress(model);
    const gauge=button.querySelector('.activity-gauge');
    button.classList.toggle('working',active>0);
    button.classList.toggle('waiting',!active&&(queued>0||blocked>0));
    button.classList.toggle('issue',!active&&(errors>0||model.issues?.length>0));
    // Multiple tasks have no combined percentage. Keep the running ring alive.
    gauge?.classList.toggle('indeterminate',Boolean(active&&(!compact||compact.indeterminate)));
    button.style.setProperty('--activity-progress',`${compact?.percent||0}%`);
    const summary=active?`${active} active${queued?` · ${queued} waiting`:''}${blocked?` · ${blocked} paused`:''}`
      : queued?`${queued} waiting${blocked?` · ${blocked} paused`:''}`
      : blocked?`${blocked} paused`:errors?`${errors} recent issue${errors===1?'':'s'}`:issues?`${issues} thumbnail issue${issues===1?'':'s'}`:'';
    const count=button.querySelector('.activity-count');
    count.textContent=summary;
    count.dataset.compact=String(active||queued||blocked||errors||issues||'');
    button.dataset.activityState=active?'running':queued?'waiting':blocked?'paused':errors||issues?'issue':'idle';
    const details=model.active.map(item=>`${taskTitle(item)}: ${item.detail||progress(item).detail||item.phase||'Working'}`);
    button.title=[summary||'Nothing running',...details].join('\n');
    button.setAttribute('aria-label',`Activity · ${summary||'Nothing running'}`);
    window.dispatchEvent(new CustomEvent('mochimono:activity-model',{detail:model}));
    window.dispatchEvent(new CustomEvent('mochimono:background-state',{detail:{mode:model.state?.background?.mode||'idle',allowed:Boolean(model.state?.background?.allowed)}}));
    if(!dialog?.open||Date.now()<interactionUntil)return;

    const status=overview(model);
    const body=dialog.querySelector('[data-body]');
    const overviewNode=body.querySelector('.activity-overview');
    overviewNode.className=`activity-overview ${status.className}`;
    overviewNode.querySelector('strong').textContent=status.title;
    overviewNode.querySelector('span').textContent=status.detail;
    for(const key of ['active','queued','blocked','issues','recent'])syncRows(body.querySelector(`[data-section="${key}"]`),model[key]||[],key==='recent');
    const recent=body.querySelector('.activity-recent');
    recent.classList.toggle('open',recentOpen);
    recent.querySelector('[data-recent-toggle]').setAttribute('aria-expanded',String(recentOpen));
  }

  async function handleAction(event){
    const recent=event.target.closest('[data-recent-toggle]');
    if(recent){
      event.preventDefault();
      event.stopImmediatePropagation();
      recentOpen=!recentOpen;
      sessionStorage.setItem(RECENT_OPEN_KEY,recentOpen?'1':'0');
      recent.closest('.activity-recent')?.classList.toggle('open',recentOpen);
      recent.setAttribute('aria-expanded',recentOpen?'true':'false');
      return;
    }
    const cancel=event.target.closest('[data-cancel]'); if(!cancel)return;
    const item=[...(lastModel?.active||[]),...(lastModel?.queued||[])].find(entry=>entry.id===cancel.dataset.cancel); if(!item)return;
    cancel.disabled=true;
    try{
      if(item.source==='squish')await request(`/api/work/${item.rawId}/cancel`,{method:'POST'});
      else if(item.source==='squish-batch')await Promise.allSettled(item.rawIds.map(id=>request(`/api/work/${id}/cancel`,{method:'POST'})));
      else await request('/api/job/cancel',{method:'POST'});
      schedule(0);
    }catch(error){toast(error.message);cancel.disabled=false;}
  }

  function loadBrowserNames(child){
    const api=child?.mochimonoBrowserFolders;
    const loader=api?.names?.bind(api)||api?.list?.bind(api);
    Promise.resolve(loader?.()).then(items=>{
      let changed=false;
      for(const item of items||[]){const id=String(item.id),name=String(item.name||'Browser folder');if(browserNames.get(id)!==name){browserNames.set(id,name);changed=true;}}
      if(changed)schedule(0);
    }).catch(()=>{});
  }

  function ingestBrowserSync(detail,sourceWindow=window){
    detail=detail||{};
    const id=String(detail.id||'');
    if(!id)return;
    const name=String(detail.name||'');
    if(name)browserNames.set(id,name);
    if(detail.state==='running'||detail.state==='queued')browserSyncs.set(id,{...detail,id});
    else browserSyncs.delete(id);
    if(!name&&!browserNames.has(id))loadBrowserNames(sourceWindow);
    schedule(60);
  }

  function attachBrowserFolderEvents(){
    const child=frame?.contentWindow;
    if(!child||attachedGeneration===frameGeneration)return;
    attachedGeneration=frameGeneration;
    child.addEventListener('mochimono:browser-folder-sync',event=>ingestBrowserSync(event.detail,child));
    child.addEventListener('mochimono:browser-folders-ready',()=>loadBrowserNames(child),{once:true});
    loadBrowserNames(child);
  }

  window.addEventListener('mochimono:browser-folder-sync',event=>ingestBrowserSync(event.detail,window));
  frame?.addEventListener('load',()=>{frameGeneration++;attachedGeneration=-1;setTimeout(attachBrowserFolderEvents,50);});
  attachBrowserFolderEvents();

  async function refresh(){
    clearTimeout(timer);timer=0;
    if(busy||document.hidden)return schedule(2500);
    const minGap=dialog?.open?500:1000;
    const since=Date.now()-lastRefreshAt;
    if(since<minGap)return schedule(minGap-since);
    busy=true;
    lastRefreshAt=Date.now();
    try{
      attachBrowserFolderEvents();
      const wantsWork=Boolean(frame?.getAttribute('src'));
      const requests=[request('/api/state'),request('/api/folder-stats')];
      if(wantsWork)requests.push(request('/api/work'));
      const results=await Promise.allSettled(requests);
      const state=results[0].status==='fulfilled'?results[0].value:null;
      if(!state)throw results[0].reason||new Error('Activity unavailable');
      if(results[1].status!=='fulfilled')throw results[1].reason||new Error('Folder activity unavailable');
      const stats=results[1].value;
      const work=wantsWork&&results[2]?.status==='fulfilled'?results[2].value:{jobs:[]};
      render(buildModel(state,stats,work));
    }catch(error){button.title=error.message;}
    finally{
      busy=false;
      const delay=lastModel?.active?.length?1000:dialog?.open?2200:4000;
      schedule(delay);
    }
  }

  function schedule(delay=0){clearTimeout(timer);timer=setTimeout(refresh,Math.max(0,delay));}
  button.onclick=()=>{const box=ensureDialog();button.classList.add('active');if(!box.open)box.showModal();button.setAttribute('aria-expanded','true');render(lastModel||{state:{background:{mode:'idle'}},active:[],queued:[],recent:savedRecent()});schedule(0);};
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)schedule(100);});
  window.addEventListener('focus',()=>schedule(100));
  window.addEventListener('mochimono:storage-changed',()=>schedule(0));
  schedule(100);
}
