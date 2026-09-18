import './navigation-ux.js';

const host = document.querySelector('.client-head-actions');
const toastNode = document.querySelector('#toast');
const frame = document.querySelector('#filesFrame');

if (host) {
  const RECENT_KEY = 'mochimono.activity.recent';
  const RECENT_OPEN_KEY = 'mochimono.activity.recent.open';
  const MODE_LABEL = { off:'On view', idle:'Idle', max:'Always' };
  let dialog = null;
  let button = null;
  let timer = 0;
  let busy = false;
  let lastModel = null;
  let lastRefreshAt = 0;
  let lastBodyHtml = '';
  let interactionUntil = 0;
  let recentOpen = sessionStorage.getItem(RECENT_OPEN_KEY) === '1';
  let frameGeneration = 0;
  let attachedGeneration = -1;
  const browserSyncs = new Map();
  const browserNames = new Map();

  const style = document.createElement('style');
  style.textContent = `
    .activity-button{--activity-progress:0%;height:32px;display:flex;align-items:center;gap:7px;padding:0 10px;border:1px solid transparent;border-radius:9px;background:transparent;color:#958c89;font-size:12px;font-weight:760;white-space:nowrap}
    .activity-button:hover,.activity-button.active{border-color:#322d31;background:#211e22;color:#f0e9e5}.activity-gauge{position:relative;width:17px;height:17px;flex:0 0 auto;border-radius:50%;background:#3a3538}.activity-gauge:after{content:'';position:absolute;inset:3px;border-radius:50%;background:#111012}.activity-button.working .activity-gauge{background:conic-gradient(#e99b95 var(--activity-progress),#3a3538 0)}.activity-button.working .activity-gauge.indeterminate{background:conic-gradient(#e99b95 0 24%,#3a3538 24% 100%);animation:activity-spin .9s linear infinite}.activity-button:not(.working) .activity-gauge{width:8px;height:8px}.activity-button:not(.working) .activity-gauge:after{display:none}.activity-button:not(.working):not(.issue) .activity-gauge{background:#6d6668}.activity-button.issue:not(.working) .activity-gauge{background:#d3a067}.activity-count{min-width:15px;color:#cfc3bf;font-size:11px;font-variant-numeric:tabular-nums}
    .activity-dialog{width:min(680px,calc(100vw - 24px));max-height:min(820px,calc(100dvh - 24px));padding:0;overflow:hidden}.activity-dialog .dialog-head{padding:17px 20px 14px;border-bottom:1px solid #292529}.activity-dialog .dialog-head h3{font-size:18px;font-weight:820;letter-spacing:-.02em}.activity-body{max-height:calc(min(820px,100dvh - 24px) - 60px);overflow:auto;overscroll-behavior:contain;padding:20px;scrollbar-gutter:stable}
    .activity-overview{display:grid;grid-template-columns:54px minmax(0,1fr);gap:14px;align-items:center;padding:16px 17px;border-radius:16px;background:#151316;box-shadow:inset 0 0 0 1px #2b272b}.activity-orb{width:50px;height:50px;display:grid;place-items:center;border-radius:15px;background:#211e22}.activity-orb i{width:15px;height:15px;border:3px solid #777073;border-radius:50%}.activity-overview.working .activity-orb{background:#281d20}.activity-overview.working .activity-orb i{border-color:#e99b95;border-right-color:transparent;animation:activity-spin 1s linear infinite}.activity-overview.waiting .activity-orb i{border:0;width:12px;height:12px;background:#b08c68;box-shadow:0 0 0 7px rgba(176,140,104,.1)}.activity-overview strong{display:block;color:#f1e9e5;font-size:22px;font-weight:820;letter-spacing:-.03em}.activity-overview span{display:block;margin-top:3px;color:#988f8b;font-size:13px;font-weight:620}
    .activity-setting{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:12px;padding:10px 12px 10px 15px;border-radius:13px;background:#111012}.activity-setting>strong{color:#d8cfcb;font-size:13px;font-weight:760}.activity-mode-buttons{display:flex;gap:4px;padding:3px;border-radius:10px;background:#1d1a1e}.activity-mode-buttons button{height:34px;min-width:72px;padding:0 11px;border:0;border-radius:7px;background:transparent;color:#8d8581;font-size:11.5px;font-weight:760;white-space:nowrap}.activity-mode-buttons button:hover{color:#e2d9d5}.activity-mode-buttons button.active{background:#373136;color:#f3ebe7;box-shadow:0 1px 4px rgba(0,0,0,.22)}
    .activity-section{margin-top:22px}.activity-section-head{display:flex;align-items:center;gap:8px;margin:0 2px 9px;color:#c7beba;font-size:13px;font-weight:800}.activity-section-head b{min-width:22px;padding:2px 6px;border-radius:999px;background:#211e22;color:#8f8783;font-size:10px;font-weight:760;text-align:center}.activity-list{display:grid;gap:8px}
    .activity-row{display:grid;grid-template-columns:42px minmax(0,1fr) auto;gap:12px;align-items:center;min-width:0;padding:12px 13px;border:0;border-radius:14px;background:#141214;box-shadow:inset 0 0 0 1px #272327}.activity-row.running{background:#181315;box-shadow:inset 3px 0 0 #d98f89,inset 0 0 0 1px #30272a}.activity-row.error{box-shadow:inset 3px 0 0 #bc6e76,inset 0 0 0 1px #38272b}.activity-task-icon{width:40px;height:40px;display:grid;place-items:center;border-radius:11px;background:#211e22;color:#b8afab}.activity-row.running .activity-task-icon{background:#2a2023;color:#e3aaa5}.activity-task-icon svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.activity-row-main{min-width:0}.activity-row-head{min-width:0}.activity-row-head strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e9e0dc;font-size:14.5px;font-weight:790;letter-spacing:-.012em}.activity-detail{margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#958c88;font-size:11.5px;font-weight:560;font-variant-numeric:tabular-nums}.activity-progress{height:7px;margin-top:10px;overflow:hidden;border-radius:99px;background:#2a262a}.activity-progress i{display:block;height:100%;min-width:3px;border-radius:inherit;background:#df938d;transition:width .3s ease}.activity-progress.indeterminate i{width:34%;animation:activity-slide 1.25s ease-in-out infinite}.activity-side{display:flex;align-items:center;gap:7px;color:#8a817e;font-size:11px;font-weight:700;white-space:nowrap}.activity-percent{color:#cfc4c0;font-variant-numeric:tabular-nums}.activity-cancel{width:30px;height:30px;border:0;border-radius:8px;background:#211e22;color:#9c918d;padding:0;font-size:0}.activity-cancel:hover{background:#302b30;color:#f0e7e3}.activity-cancel:after{content:'×';font-size:17px}.activity-empty{padding:14px 2px;color:#827a77;font-size:12px}
    .activity-recent{margin-top:20px;padding-top:4px;border-top:1px solid #292529}.activity-recent .activity-list,.activity-recent .activity-empty{display:none}.activity-recent.open .activity-list,.activity-recent.open .activity-empty{display:grid}.activity-recent .activity-section-head{margin:0;padding:12px 2px 2px;cursor:pointer;user-select:none}.activity-recent .activity-section-head:hover{color:#eee5e1}.activity-recent .activity-section-head:after{content:'›';margin-left:auto;font-size:19px;color:#8f8582;transform:rotate(90deg);transition:transform .15s}.activity-recent.open .activity-section-head:after{transform:rotate(-90deg)}.activity-recent.open .activity-list,.activity-recent.open .activity-empty{margin-top:8px}.activity-recent .activity-row{grid-template-columns:34px minmax(0,1fr) auto;padding:9px 11px;border-radius:11px;background:#111012}.activity-recent .activity-task-icon{width:32px;height:32px;border-radius:9px}.activity-recent .activity-task-icon svg{width:18px;height:18px}.activity-recent .activity-row-head strong{font-size:13px}.activity-recent .activity-detail,.activity-recent .activity-progress{display:none}
    @keyframes activity-pulse{0%,100%{transform:scale(.72);opacity:.55}50%{transform:scale(1.2);opacity:1}}@keyframes activity-spin{to{transform:rotate(360deg)}}@keyframes activity-slide{0%{transform:translateX(-115%)}50%{transform:translateX(105%)}100%{transform:translateX(315%)}}
    @media(max-width:700px){.activity-button{padding:0 7px}.activity-button .activity-label{display:none}.activity-body{padding:14px}.activity-setting{align-items:stretch;flex-direction:column}.activity-mode-buttons{display:grid;grid-template-columns:repeat(3,1fr)}.activity-mode-buttons button{min-width:0}.activity-row{grid-template-columns:38px minmax(0,1fr) auto;padding:11px}.activity-task-icon{width:36px;height:36px}}
    @media(prefers-reduced-motion:reduce){.activity-gauge,.activity-progress i,.activity-orb i{animation:none!important;transition:none!important}}
  `;
  document.head.append(style);
  document.querySelector('.preview-mode-row')?.remove();

  button = document.createElement('button');
  button.type = 'button';
  button.className = 'activity-button';
  button.innerHTML = '<i class="activity-gauge"></i><span class="activity-label">Activity</span><span class="activity-count"></span>';
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
    if(kind==='Thumbnail')return title==='Library'?'Generate thumbnails':`Generate thumbnails · ${title}`;
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
    const phase=parts.find(part=>!/^\d/.test(part)&&!/\d+\s*(?:files?|ready|checked|copied|queued|waiting|left|\/s|[KMGTP]?B)/i.test(part));
    const metric=parts.find(part=>/\d/.test(part)&&/(?:files?|ready|checked|copied|queued|waiting|left|\/s|[KMGTP]?B)/i.test(part));
    return [phase,metric].filter(Boolean).slice(0,2).join(' · ')||parts[0]||text;
  }

  function progress(job){
    const p=job?.progress||{};
    const totalBytes=Number(p.totalBytes)||0;
    const doneBytes=Math.min(totalBytes,Number(p.doneBytes)||Number(p.copiedBytes)||0);
    const total=Number(p.total)||0;
    const checked=Number(p.checked??p.hashed??p.scanned)||0;
    const percent=totalBytes?doneBytes/totalBytes*100:total?checked/total*100:null;
    const detail=[];
    if(p.phase)detail.push(p.phase);
    if(totalBytes)detail.push(`${bytes(doneBytes)} / ${bytes(totalBytes)}`);
    else if(total)detail.push(`${checked.toLocaleString()} / ${total.toLocaleString()} files`);
    else if(p.scanned!=null)detail.push(`${Number(p.scanned).toLocaleString()} files`);
    if(p.copied!=null)detail.push(`${Number(p.copied).toLocaleString()} copied`);
    if(p.speedBps>0)detail.push(`${bytes(p.speedBps)}/s`);
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
        const done=Number(diagnostics.hashProcessed)||0;
        const total=Number(diagnostics.hashTotal)||0;
        active.push({
          id:`folder:${key}`,source:'folder',kind:hashing?'Hash':'Index',type:hashing?'hash':'sync',title:name,
          label:`${hashing?'Hash':'Index'} ${name}`,path,status:'running',cancelable:false,
          detail:total?`${done.toLocaleString()} / ${total.toLocaleString()} files`:`${Number(folder.files||0).toLocaleString()} files found`,
          percent:total?done/total*100:null,phase:hashing?'Hashing content':'Indexing files',
          progress:{path,phase:hashing?'Hashing content':'Indexing files',hashed:hashing?done:undefined,checked:hashing?undefined:done,total,indeterminate:!total}
        });
      } else if(folder.pending&&!globalHere){
        queued.push({id:`folder:${key}`,source:'folder',kind:folder.protected===false?'Index':'Sync',title:name,status:'queued',detail:folder.waitingForIdle?'Waiting until your PC is idle':'Waiting to start'});
      }
      if(folder.hashPending>0&&!folder.hashing)queued.push({id:`hash:${key}`,source:'folder',kind:'Hash',title:name,status:'queued',detail:`${Number(folder.hashPending).toLocaleString()} files${folder.hashWaiting?' · waiting until your PC is idle':''}`});
      if(folder.lastIndexed)recent.push({id:`recent-index:${key}:${folder.lastIndexed}`,source:'folder',kind:'Index',title:name,status:'done',finishedAt:folder.lastIndexed,detail:`${Number(folder.files||0).toLocaleString()} files indexed`});
    }
    return {active,queued,recent};
  }

  function thumbnailItems(state, stats){
    const active=[],queued=[];
    for(const folder of stats?.folders||[]){
      if(!folder.previewWarming&&!folder.previewQueueActive&&!folder.previewQueueBackground)continue;
      const name=baseName(folder.path)||folder.path||'Folder';
      const total=Number(folder.previewTotal)||0;
      const checking=String(folder.previewPhase||'generating')==='checking';
      const ready=Math.min(total||Infinity,(Number(folder.previewReady)||0)+(Number(folder.previewGenerated)||0));
      const done=checking?(Number(folder.previewProcessed)||0):ready;
      const activeCount=Number(folder.previewQueueActive)||0;
      const waiting=Boolean(folder.previewWaiting);
      const detail=[];
      if(total)detail.push(`${Math.min(done,total).toLocaleString()} / ${total.toLocaleString()} ${checking?'checked':'ready'}`);
      else if(done)detail.push(`${done.toLocaleString()} ${checking?'checked':'ready'}`);
      if(activeCount)detail.push(`${activeCount} generating`);
      if(folder.previewQueueBackground)detail.push(`${Number(folder.previewQueueBackground).toLocaleString()} queued`);
      if(folder.previewFailed)detail.push(`${Number(folder.previewFailed).toLocaleString()} failed`);
      if(waiting)detail.push('Waiting until your PC is idle');
      const phase=checking?'Checking thumbnails':waiting?'Waiting until your PC is idle':'Generating thumbnails';
      const item={id:`thumbs:${String(folder.path||'').toLowerCase()}`,source:'preview',kind:'Thumbnail',type:'thumbnail',title:name,label:`Thumbnails ${name}`,path:folder.path,status:activeCount?'running':'queued',cancelable:false,detail:detail.join(' · '),percent:total?done/total*100:null,phase,progress:{path:folder.path,phase,checked:done,total,indeterminate:!total}};
      (activeCount?active:queued).push(item);
    }

    const previews=state?.previews||{};
    const activeCount=Number(previews.active)||0;
    const waitingCount=(Number(previews.urgent)||0)+(Number(previews.priority)||0)+(Number(previews.queued)||0);
    if(activeCount||waitingCount){
      const wait=state?.settings?.thumbnailMode==='off'?'Generated when viewed':previews.waitingForIdle?'Waiting until your PC is idle':'';
      const item={id:'thumbs:library',source:'preview',kind:'Thumbnail',title:'Library',status:activeCount?'running':'queued',detail:[activeCount?`${activeCount} generating`:'',waitingCount?`${waitingCount.toLocaleString()} waiting`:'',wait].filter(Boolean).join(' · '),phase:wait||'Generating thumbnails'};
      (activeCount?active:queued).push(item);
    }
    return {active,queued};
  }

  function browserItems(){
    const active=[],queued=[];
    for(const item of browserSyncs.values()){
      const waiting=item.state==='queued';
      const entry={
        id:`browser:${item.id}`,source:'browser',kind:'Index',title:browserNames.get(item.id)||'Local folder',status:waiting?'queued':'running',
        detail:waiting?'Waiting to index':[`${Number(item.scanned||0).toLocaleString()} files indexed`,item.transferred?`${Number(item.transferred).toLocaleString()} new or changed`:'',item.skipped?`${Number(item.skipped).toLocaleString()} unchanged`:'' ].filter(Boolean).join(' · '),
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
    return {state,active,queued,recent:unique};
  }

  function markInteraction(){ interactionUntil=Date.now()+900; }

  function ensureDialog(){
    if(dialog)return dialog;
    dialog=document.createElement('dialog');
    dialog.className='small-dialog activity-dialog';
    dialog.innerHTML='<div class="dialog-head"><h3>Activity</h3><button class="icon" data-close>×</button></div><div class="activity-body" data-body></div>';
    document.body.append(dialog);
    const body=dialog.querySelector('[data-body]');
    body.addEventListener('wheel',markInteraction,{passive:true});
    body.addEventListener('touchmove',markInteraction,{passive:true});
    body.addEventListener('scroll',markInteraction,{passive:true});
    dialog.querySelector('[data-close]').onclick=()=>dialog.close();
    dialog.addEventListener('close',()=>{button.classList.remove('active');schedule(0);});
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
    const bar=!recent&&item.status==='running'?`<div class="activity-progress ${indeterminate?'indeterminate':''}"><i style="width:${indeterminate?'34%':`${Math.max(1,pct(percent))}%`}"></i></div>`:'';
    const concise=compactDetail(item,detail);
    const sidePercent=!recent&&item.status==='running'&&!indeterminate?`<span class="activity-percent">${Math.round(pct(percent))}%</span>`:'';
    const sideTime=recent&&when?`<time>${esc(age(when))}</time>`:'';
    const kind=item.kind||'Work';
    return `<div class="activity-row ${statusClass}"><div class="activity-task-icon" aria-hidden="true">${taskIcon(kind)}</div><div class="activity-row-main"><div class="activity-row-head"><strong>${esc(taskTitle(item))}</strong></div>${concise?`<div class="activity-detail">${esc(concise)}</div>`:''}${bar}</div><div class="activity-side">${sidePercent}${sideTime}${cancel}</div></div>`;
  }

  function overview(model){
    const active=model.active.length, queued=model.queued.length;
    if(active)return {className:'working',title:'Working',detail:`${active} active${queued?` · ${queued} waiting`:''}`};
    if(queued)return {className:'waiting',title:'Waiting',detail:`${queued} queued`};
    return {className:'',title:'Caught up',detail:'Nothing running'};
  }

  function buttonProgress(model){
    if(model.active.length!==1)return null;
    const item=model.active[0];
    if(item.percent!=null)return {percent:pct(item.percent),indeterminate:false};
    if(item.progress){
      const value=progress(item);
      if(value.percent!=null&&!value.indeterminate)return {percent:pct(value.percent),indeterminate:false};
    }
    return {percent:0,indeterminate:true};
  }

  function render(model){
    lastModel=model;
    const active=model.active.length, queued=model.queued.length;
    const errors=model.recent.filter(item=>item.status==='error'&&Date.now()-new Date(item.finishedAt).getTime()<86400000).length;
    const compact=buttonProgress(model);
    const gauge=button.querySelector('.activity-gauge');
    button.classList.toggle('working',active>0);
    button.classList.toggle('issue',!active&&errors>0);
    gauge?.classList.toggle('indeterminate',Boolean(active&&compact?.indeterminate));
    button.style.setProperty('--activity-progress',`${compact?.percent||0}%`);
    button.querySelector('.activity-count').textContent=active||queued?String(active+queued):'';
    const primary=active===1?taskTitle(model.active[0]):'';
    button.title=active===1&&compact&&!compact.indeterminate
      ? `${primary} · ${Math.round(compact.percent)}%`
      : active?`${active} working${queued?` · ${queued} waiting`:''}`
      : queued?`${queued} waiting`
      : errors?`${errors} recent issue${errors===1?'':'s'}`
      :'Activity';
    window.dispatchEvent(new CustomEvent('mochimono:activity-model',{detail:model}));
    window.dispatchEvent(new CustomEvent('mochimono:background-state',{detail:{mode:model.state?.settings?.thumbnailMode||'idle',allowed:Boolean(model.state?.background?.allowed)}}));
    if(!dialog?.open||Date.now()<interactionUntil)return;

    const mode=model.state?.settings?.thumbnailMode||'idle';
    const status=overview(model);
    const html=`
      <div class="activity-overview ${status.className}"><div class="activity-orb" aria-hidden="true"><i></i></div><div><strong>${esc(status.title)}</strong><span>${esc(status.detail)}</span></div></div>
      <div class="activity-setting"><strong>Thumbnails</strong><div class="activity-mode-buttons" role="group" aria-label="Thumbnail generation">${['off','idle','max'].map(value=>`<button type="button" data-mode="${value}" class="${mode===value?'active':''}">${esc(MODE_LABEL[value])}</button>`).join('')}</div></div>
      ${active?`<section class="activity-section"><div class="activity-section-head">Now <b>${active}</b></div><div class="activity-list">${model.active.map(item=>row(item)).join('')}</div></section>`:''}
      ${queued?`<section class="activity-section"><div class="activity-section-head">Waiting <b>${queued}</b></div><div class="activity-list">${model.queued.map(item=>row(item)).join('')}</div></section>`:''}
      <section class="activity-section activity-recent ${recentOpen?'open':''}"><div class="activity-section-head" data-recent-toggle aria-expanded="${recentOpen?'true':'false'}">Recent <b>${model.recent.length}</b></div>${model.recent.length?`<div class="activity-list">${model.recent.map(item=>row(item,true)).join('')}</div>`:'<div class="activity-empty">Nothing recent</div>'}</section>`;
    if(html===lastBodyHtml)return;
    const body=dialog.querySelector('[data-body]');
    const scrollTop=body.scrollTop;
    lastBodyHtml=html;
    body.innerHTML=html;
    body.scrollTop=Math.min(scrollTop,Math.max(0,body.scrollHeight-body.clientHeight));
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
      lastBodyHtml='';
      return;
    }
    const modeButton=event.target.closest('[data-mode]');
    if(modeButton){
      const buttons=[...dialog.querySelectorAll('[data-mode]')];buttons.forEach(item=>item.disabled=true);
      try{await request('/api/settings',{method:'POST',body:{thumbnailMode:modeButton.dataset.mode}});schedule(0);}catch(error){toast(error.message);}finally{buttons.forEach(item=>item.disabled=false);}
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
    Promise.resolve(child?.mochimonoBrowserFolders?.list?.()).then(items=>{
      let changed=false;
      for(const item of items||[]){const id=String(item.id),name=String(item.name||'Browser folder');if(browserNames.get(id)!==name){browserNames.set(id,name);changed=true;}}
      if(changed)schedule(0);
    }).catch(()=>{});
  }

  function ingestBrowserSync(detail,sourceWindow=window){
    detail=detail||{};
    const id=String(detail.id||'');
    if(!id)return;
    if(detail.state==='running'||detail.state==='queued')browserSyncs.set(id,{...detail,id});
    else browserSyncs.delete(id);
    loadBrowserNames(sourceWindow);
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
      const stats=results[1].status==='fulfilled'?results[1].value:{folders:[]};
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
  button.onclick=()=>{const box=ensureDialog();button.classList.add('active');if(!box.open)box.showModal();lastBodyHtml='';render(lastModel||{state:{settings:{thumbnailMode:'idle'}},active:[],queued:[],recent:savedRecent()});schedule(0);};
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)schedule(100);});
  window.addEventListener('focus',()=>schedule(100));
  schedule(100);
}
