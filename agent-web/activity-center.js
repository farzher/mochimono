import './navigation-ux.js';

const host = document.querySelector('.client-head-actions');
const toastNode = document.querySelector('#toast');
const frame = document.querySelector('#filesFrame');

if (host) {
  const RECENT_KEY = 'mochimono.activity.recent';
  const RECENT_OPEN_KEY = 'mochimono.activity.recent.open';
  const MODE_LABEL = { off:'On demand', idle:'Idle', max:'Max' };
  const KIND_GLYPH = new Map([
    ['Index','▦'],['Sync','↻'],['Hash','#'],['Thumbnail','▧'],['Backup','◇'],
    ['Friend Drive','↔'],['Squish','⇥'],['Verify','✓'],['Restore','↩'],['Work','•']
  ]);
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
    .activity-button{height:31px;display:flex;align-items:center;gap:8px;padding:0 9px;border:1px solid transparent;border-radius:8px;background:transparent;color:#8d8584;font-size:12px;font-weight:760;white-space:nowrap}
    .activity-button:hover,.activity-button.active{border-color:#2d292d;background:#211e22;color:#eee7e3}.activity-dot{width:6px;height:6px;border-radius:50%;background:#696164}.activity-button.working .activity-dot{background:#e99b95;animation:activity-pulse .9s ease-in-out infinite}.activity-button.issue .activity-dot{background:#d3a067}.activity-count{display:inline-flex;gap:4px;align-items:center;color:#d8cfcb;font-size:11px;font-variant-numeric:tabular-nums}.activity-count i{font-style:normal;color:#7f7775}.activity-count b{color:#d8cfcb;font-weight:800}
    .activity-dialog{width:min(620px,calc(100vw - 24px));max-height:min(820px,calc(100dvh - 24px));padding:0;overflow:hidden}.activity-dialog .dialog-head{padding:16px 18px 13px;border-bottom:1px solid #292529}.activity-dialog .dialog-head h3{font-size:16px;font-weight:800;letter-spacing:-.015em}.activity-body{max-height:calc(min(820px,100dvh - 24px) - 58px);overflow:auto;overscroll-behavior:contain;padding:14px 16px 18px;scrollbar-gutter:stable}
    .activity-mode{display:block;padding:3px;margin:0 0 13px;border:0;background:transparent}.activity-mode-copy{display:none}.activity-mode-buttons{width:100%;display:grid;grid-template-columns:repeat(3,1fr);gap:4px;padding:4px;border-radius:12px;background:#1d1a1e}.activity-mode-buttons button{height:38px;padding:0 8px;border:0;border-radius:8px;background:transparent;color:#817977;font-size:12px;font-weight:780}.activity-mode-buttons button:hover{color:#ddd4d0}.activity-mode-buttons button.active{background:#302b30;color:#f0e8e4}
    .activity-summary{display:flex;align-items:center;min-height:36px;gap:8px;margin:0 0 11px}.activity-stat{display:inline-flex;align-items:center;gap:6px;min-height:29px;padding:6px 11px;border:1px solid #292529;border-radius:999px;background:#111012;color:#8c8380;font-size:11px;font-weight:680;font-variant-numeric:tabular-nums}.activity-stat b{font-size:13px;color:#d8cfcb;font-weight:800}.activity-stat.working{border-color:#3b3032}.activity-stat.waiting{color:#948a86}
    .activity-section{margin-top:14px}.activity-section-head{display:flex;align-items:center;gap:7px;min-height:26px;margin:0 0 8px;color:#918884;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.035em}.activity-section-head b{min-width:21px;height:20px;display:inline-grid;place-items:center;padding:0 6px;border-radius:999px;background:#211e22;color:#b9afab;font-size:10px;font-weight:800}.activity-list{display:grid;gap:6px}
    .activity-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:11px;padding:12px 13px;border:1px solid #292529;border-radius:12px;background:#111012}.activity-row.running{border-color:#3b3032;background:#151113}.activity-row.error{border-color:#442d31}.activity-main{min-width:0}.activity-title{display:flex;align-items:center;gap:10px;color:#e4dbd7;font-size:13px;font-weight:780}.activity-kind{flex:0 0 auto;width:30px;height:30px;display:grid;place-items:center;border-radius:8px;background:#262227;color:#aaa09c;font-size:14px}.activity-title span:last-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.activity-detail{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:7px}.activity-metric{display:inline-flex;align-items:center;min-height:24px;padding:4px 8px;border-radius:7px;background:#211e22;color:#aaa19d;font-size:11px;font-weight:650;font-variant-numeric:tabular-nums}.activity-detail.wait .activity-metric{color:#b5a397}.activity-current{display:none}
    .activity-progress{height:6px;margin-top:9px;overflow:hidden;border-radius:99px;background:#292529}.activity-progress i{display:block;height:100%;min-width:2px;border-radius:inherit;background:#e99b95;transition:width .3s ease}.activity-progress.indeterminate i{width:30%;animation:activity-slide 1.3s ease-in-out infinite}.activity-side{display:flex;align-items:start;gap:7px;color:#8d8581;font-size:10.5px;font-weight:650;white-space:nowrap}.activity-side time{padding-top:5px}.activity-cancel{width:29px;height:29px;border:0;border-radius:7px;background:transparent;color:#918784;padding:0;font-size:0}.activity-cancel:after{content:'×';font-size:14px}.activity-empty{padding:16px 8px;color:#77706e;text-align:center;font-size:12px;font-weight:650}
    .activity-recent{margin-top:8px;padding-top:4px}.activity-recent .activity-list,.activity-recent .activity-empty{display:none}.activity-recent.open .activity-list,.activity-recent.open .activity-empty{display:grid}.activity-recent .activity-section-head{margin:0;padding:10px 4px;border-top:1px solid #292529;cursor:pointer;user-select:none}.activity-recent .activity-section-head:hover{color:#d3c9c5}.activity-recent .activity-section-head:after{content:'›';margin-left:auto;font-size:18px;color:#8f8582;transform:rotate(90deg);transition:transform .15s}.activity-recent.open .activity-section-head:after{transform:rotate(-90deg)}.activity-recent.open .activity-list,.activity-recent.open .activity-empty{margin-top:7px}.activity-recent .activity-row:not(.error){min-height:56px;align-items:center}.activity-recent .activity-row:not(.error) .activity-detail{display:none}
    @keyframes activity-pulse{0%,100%{transform:scale(.72);opacity:.55}50%{transform:scale(1.2);opacity:1}}@keyframes activity-slide{0%{transform:translateX(-115%)}50%{transform:translateX(105%)}100%{transform:translateX(315%)}}
    @media(max-width:700px){.activity-button{padding:0 7px}.activity-button .activity-label{display:none}.activity-dialog .activity-body{padding:12px}.activity-mode-buttons button{height:36px}.activity-row{grid-template-columns:1fr}.activity-title{font-size:12.5px}.activity-side{justify-content:flex-end}}
    @media(prefers-reduced-motion:reduce){.activity-dot,.activity-progress i{animation:none!important;transition:none!important}}
  `;
  document.head.append(style);
  document.querySelector('.preview-mode-row')?.remove();

  button = document.createElement('button');
  button.type = 'button';
  button.className = 'activity-button';
  button.innerHTML = '<i class="activity-dot"></i><span class="activity-label">Activity</span><span class="activity-count"></span>';
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
  function metricText(value) {
    let text=String(value||'').trim();
    if(!text)return '';
    if(/^waiting for idle$/i.test(text))return '◷';
    if(/^on demand$/i.test(text))return 'Ⅱ';
    return text.replace(/\bfiles?\b/gi,'').replace(/\bready\b/gi,'').replace(/\bchecked\b/gi,'').replace(/\bfound\b/gi,'')
      .replace(/^([\d,.]+)\s+generating$/i,'↻ $1').replace(/^([\d,.]+)\s+(queued|waiting)$/i,'… $1').replace(/^([\d,.]+)\s+copied$/i,'↑ $1')
      .replace(/\s+left$/i,'').replace(/\s+/g,' ').trim();
  }

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
    if(job?.type==='sync')return {kind:'Index',title:label.replace(/^(Sync|Check|Update) /,'')};
    if(job?.type==='backup'||job?.type==='protection')return {kind:'Backup',title:label.replace(/^Update /,'')};
    if(job?.type==='verify')return {kind:'Verify',title:label.replace(/^Verify /,'')};
    if(job?.type==='restore')return {kind:'Restore',title:label.replace(/^Restore /,'')};
    return {kind:'Work',title:label||job?.type||'Working'};
  }
  function jobItem(job, source, cancelable=false){const op=operation(job);return {...job,source,kind:op.kind,title:op.title,cancelable};}

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
        active.push({id:`folder:${key}`,source:'folder',kind:hashing?'Hash':'Index',title:name,status:'running',detail:total?`${done.toLocaleString()} / ${total.toLocaleString()} files`:`${Number(folder.files||0).toLocaleString()} files found`,percent:total?done/total*100:null,phase:hashing?'Hashing files':'Indexing files'});
      } else if(folder.pending&&!globalHere){
        queued.push({id:`folder:${key}`,source:'folder',kind:folder.protected===false?'Index':'Sync',title:name,status:'queued',detail:folder.waitingForIdle?'Waiting for idle':'Waiting to scan'});
      }
      if(folder.hashPending>0&&!folder.hashing)queued.push({id:`hash:${key}`,source:'folder',kind:'Hash',title:name,status:'queued',detail:`${Number(folder.hashPending).toLocaleString()} files${folder.hashWaiting?' · waiting for idle':''}`});
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
      if(waiting)detail.push('waiting for idle');
      const item={id:`thumbs:${String(folder.path||'').toLowerCase()}`,source:'preview',kind:'Thumbnail',title:name,status:activeCount?'running':'queued',detail:detail.join(' · '),percent:total?done/total*100:null,phase:checking?'Checking thumbnails':waiting?'Waiting for idle':'Generating thumbnails'};
      (activeCount?active:queued).push(item);
    }

    const previews=state?.previews||{};
    const activeCount=Number(previews.active)||0;
    const waitingCount=(Number(previews.urgent)||0)+(Number(previews.priority)||0)+(Number(previews.queued)||0);
    if(activeCount||waitingCount){
      const wait=state?.settings?.thumbnailMode==='off'?'On demand':previews.waitingForIdle?'Waiting for idle':'';
      const item={id:'thumbs:library',source:'preview',kind:'Thumbnail',title:'Library',status:activeCount?'running':'queued',detail:[activeCount?`${activeCount} generating`:'',waitingCount?`${waitingCount.toLocaleString()} waiting`:'',wait].filter(Boolean).join(' · '),phase:wait||'Generating thumbnails'};
      (activeCount?active:queued).push(item);
    }
    return {active,queued};
  }

  function browserItems(){
    return [...browserSyncs.values()].map(item=>({
      id:`browser:${item.id}`,source:'browser',kind:'Index',title:browserNames.get(item.id)||'Browser folder',status:'running',
      detail:[`${Number(item.scanned||0).toLocaleString()} files processed`,item.transferred?`${Number(item.transferred).toLocaleString()} new/changed`:'',item.skipped?`${Number(item.skipped).toLocaleString()} unchanged`:'' ].filter(Boolean).join(' · '),
      phase:'Indexing + thumbnails'
    }));
  }

  function squishItems(work){
    const jobs=work?.jobs||[],active=[],queued=[],recent=[];
    for(const item of jobs.filter(item=>item.status==='running'))active.push({id:`squish:${item.id}`,rawId:item.id,source:'squish',kind:'Squish',title:item.filename||item.originalHash?.slice(0,12)||'Media',status:'running',startedAt:item.startedAt,phase:item.message||'Squishing',percent:Number(item.progress)||0,cancelable:true});
    const waiting=jobs.filter(item=>item.status==='queued');
    if(waiting.length)queued.push({id:'squish:queued',source:'squish-batch',rawIds:waiting.map(item=>item.id),kind:'Squish',title:`${waiting.length.toLocaleString()} files`,status:'queued',detail:'Waiting to squish',cancelable:true});
    for(const item of jobs.filter(item=>['done','error','canceled'].includes(item.status)).slice(0,12))recent.push({id:`squish:${item.id}`,source:'squish',kind:'Squish',title:item.filename||'Media',status:item.status,finishedAt:item.finishedAt,error:item.status==='error'?item.message:'',detail:item.status==='done'?'Squished':''});
    return {active,queued,recent};
  }

  function buildModel(state,stats,work){
    rememberAgent(state?.job);
    const active=[],queued=[],recent=[];
    if(state?.job?.status==='running')active.push(jobItem(state.job,'agent',true));
    for(const item of state?.job?.queue||[])queued.push(jobItem(item,'agent-queue'));
    const folders=folderItems(state,stats), thumbs=thumbnailItems(state,stats), squish=squishItems(work);
    active.push(...folders.active,...thumbs.active,...browserItems(),...squish.active);
    queued.push(...folders.queued,...thumbs.queued,...squish.queued);
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
    let percent=item.percent??null, detail=item.detail||'', current='', indeterminate=percent==null;
    if(item.progress){const p=progress(item);percent=item.percent??p.percent;detail=item.detail||p.detail;current=p.current;indeterminate=p.indeterminate;}
    if(item.phase&&!detail)detail=item.phase;
    const when=item.status==='running'?item.startedAt:item.status==='queued'?item.queuedAt:item.finishedAt;
    const statusClass=item.status==='error'?'error':item.status==='running'?'running':'';
    const cancel=item.cancelable&&!recent?`<button class="activity-cancel" data-cancel="${esc(item.id)}" aria-label="Cancel"></button>`:'';
    const bar=!recent&&item.status==='running'?`<div class="activity-progress ${indeterminate?'indeterminate':''}"><i style="width:${indeterminate?'30%':`${Math.max(1,pct(percent))}%`}"></i></div>`:'';
    const text=recent&&item.status!=='error'?'':([detail,item.error].filter(Boolean).join(' · '));
    const metrics=text?text.split(' · ').map(metricText).filter(Boolean).map(value=>`<span class="activity-metric">${esc(value)}</span>`).join(''):'';
    const kind=item.kind||'Work';
    return `<div class="activity-row ${statusClass}"><div class="activity-main"><div class="activity-title"><span class="activity-kind" data-visual="1" title="${esc(kind)}">${esc(KIND_GLYPH.get(kind)||'•')}</span><span>${esc(item.title||'Working')}</span></div>${metrics?`<div class="activity-detail ${/waiting for idle|on demand/i.test(text)?'wait':''}" data-visual="1">${metrics}</div>`:''}${current&&!recent?`<span class="activity-current">${esc(current)}</span>`:''}${bar}</div><div class="activity-side">${when?`<time>${esc(age(when))}</time>`:''}${cancel}</div></div>`;
  }

  function render(model){
    lastModel=model;
    const active=model.active.length, queued=model.queued.length;
    const errors=model.recent.filter(item=>item.status==='error'&&Date.now()-new Date(item.finishedAt).getTime()<86400000).length;
    button.classList.toggle('working',active>0);
    button.classList.toggle('issue',!active&&errors>0);
    button.querySelector('.activity-count').innerHTML=`${active?`<i>▶</i><b>${active}</b>`:''}${queued?`<i>…</i><b>${queued}</b>`:''}`;
    button.title=active||queued?`${active} working · ${queued} waiting`:'Activity';
    window.dispatchEvent(new CustomEvent('mochimono:background-state',{detail:{mode:model.state?.settings?.thumbnailMode||'idle',allowed:Boolean(model.state?.background?.allowed)}}));
    if(!dialog?.open||Date.now()<interactionUntil)return;

    const mode=model.state?.settings?.thumbnailMode||'idle';
    const summary=active||queued?`<div class="activity-summary" data-visual="1">${active?`<span class="activity-stat working">▶ <b>${active}</b></span>`:''}${queued?`<span class="activity-stat waiting">… <b>${queued}</b></span>`:''}${mode==='idle'&&!model.state?.background?.allowed&&queued?'<span class="activity-stat waiting">◷</span>':''}</div>`:'';
    const html=`
      <div class="activity-mode"><div class="activity-mode-buttons" role="group" aria-label="Background work">${['off','idle','max'].map(value=>`<button type="button" data-mode="${value}" class="${mode===value?'active':''}">${esc(MODE_LABEL[value])}</button>`).join('')}</div></div>
      ${summary}
      ${active?`<section class="activity-section"><div class="activity-section-head">Now <b>${active}</b></div><div class="activity-list">${model.active.map(item=>row(item)).join('')}</div></section>`:''}
      ${queued?`<section class="activity-section"><div class="activity-section-head">Next <b>${queued}</b></div><div class="activity-list">${model.queued.map(item=>row(item)).join('')}</div></section>`:''}
      <section class="activity-section activity-recent ${recentOpen?'open':''}" data-visual="1"><div class="activity-section-head" data-recent-toggle aria-expanded="${recentOpen?'true':'false'}">Recently <b>${model.recent.length}</b></div>${model.recent.length?`<div class="activity-list">${model.recent.map(item=>row(item,true)).join('')}</div>`:'<div class="activity-empty">Nothing recent.</div>'}</section>`;
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

  function attachBrowserFolderEvents(){
    const child=frame?.contentWindow;
    if(!child||attachedGeneration===frameGeneration)return;
    attachedGeneration=frameGeneration;
    child.addEventListener('mochimono:browser-folder-sync',event=>{
      const detail=event.detail||{}, id=String(detail.id||''); if(!id)return;
      if(detail.state==='running')browserSyncs.set(id,{...detail,id}); else browserSyncs.delete(id);
      loadBrowserNames(child);
      schedule(80);
    });
    child.addEventListener('mochimono:browser-folders-ready',()=>loadBrowserNames(child),{once:true});
    loadBrowserNames(child);
  }
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
