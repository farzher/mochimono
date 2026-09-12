const root=document.documentElement;
const ACTIVE='experimental-view-active';
const RERUN_QUIET_MS=1500;
const CACHE_FLUSH_DELAY_MS=1000;
let lastInteractionAt=0;
let rerunTimer=0;
let rerunPending=false;
let rawRerun=null;
let cachePatched=false;
let aiPatched=false;
let rawAiIndex=null;
let wasActive=false;
let cacheFlushTimer=0;
let pendingCacheSave=null;
let pendingDimensions=new Map();
let quietTimer=0;
let quietWaiters=[];
let flushingAi=false;
const deferredAi=new Map();

const active=()=>root.classList.contains(ACTIVE);
const now=()=>performance.now();
function markInteraction(){if(active())lastInteractionAt=now()}
addEventListener('wheel',markInteraction,{capture:true,passive:true});
addEventListener('pointerdown',markInteraction,{capture:true,passive:true});
addEventListener('pointermove',markInteraction,{capture:true,passive:true});

function quietFor(ms=RERUN_QUIET_MS){return !active()||now()-lastInteractionAt>=ms}
function scheduleQuietWaiters(){
  clearTimeout(quietTimer);
  quietTimer=0;
  if(!quietWaiters.length)return;
  if(!active())return flushQuietWaiters();
  const elapsed=now()-lastInteractionAt;
  let wait=Infinity;
  for(const item of quietWaiters)wait=Math.min(wait,Math.max(20,item.ms-elapsed));
  quietTimer=setTimeout(flushQuietWaiters,Number.isFinite(wait)?wait:20);
}
function flushQuietWaiters(){
  quietTimer=0;
  if(!quietWaiters.length)return;
  const ready=[],pending=[];
  for(const item of quietWaiters)(quietFor(item.ms)?ready:pending).push(item);
  quietWaiters=pending;
  for(const item of ready)item.resolve();
  if(quietWaiters.length)scheduleQuietWaiters();
}
function waitForQuiet(ms){
  ms=Math.max(0,Number(ms)||0);
  if(quietFor(ms))return Promise.resolve();
  return new Promise(resolve=>{
    quietWaiters.push({ms,resolve});
    scheduleQuietWaiters();
  });
}
function scheduleRerun(){
  if(!rerunPending||!rawRerun)return;
  clearTimeout(rerunTimer);
  const wait=active()?Math.max(40,RERUN_QUIET_MS-(now()-lastInteractionAt)):0;
  rerunTimer=setTimeout(()=>{
    rerunTimer=0;
    if(!rerunPending)return;
    if(!quietFor()){scheduleRerun();return}
    rerunPending=false;
    rawRerun();
  },wait);
}

function patchExperimentalApi(){
  const api=window.mochimonoExperimentalViews;
  if(!api||api.__performanceGuard)return false;
  rawRerun=api.rerun?.bind(api)||null;
  if(rawRerun)api.rerun=()=>{rerunPending=true;scheduleRerun()};
  api.recentInteraction=(ms=RERUN_QUIET_MS)=>active()&&now()-lastInteractionAt<Math.max(0,Number(ms)||0);
  api.waitForQuiet=(ms=RERUN_QUIET_MS)=>waitForQuiet(ms);
  api.__performanceGuard=true;
  return true;
}

function aiKey(args){
  let options='';
  try{options=JSON.stringify(args[1]??null)}catch{options=String(args[1]??'')}
  return`${String(args[0]??'')}\u0000${options}`;
}
function deferAi(args){
  const key=aiKey(args);
  return new Promise((resolve,reject)=>{
    let entry=deferredAi.get(key);
    if(!entry){entry={args,waiters:[]};deferredAi.set(key,entry)}
    else entry.args=args;
    entry.waiters.push({resolve,reject});
  });
}
async function flushDeferredAi(){
  if(active()||flushingAi||!rawAiIndex||!deferredAi.size)return;
  flushingAi=true;
  try{
    const entries=[...deferredAi.entries()];
    deferredAi.clear();
    for(let index=0;index<entries.length;index++){
      const[key,entry]=entries[index];
      if(active()){
        const existing=deferredAi.get(key);
        if(existing)existing.waiters.push(...entry.waiters);
        else deferredAi.set(key,entry);
        for(let rest=index+1;rest<entries.length;rest++){
          const[nextKey,next]=entries[rest],queued=deferredAi.get(nextKey);
          if(queued)queued.waiters.push(...next.waiters);
          else deferredAi.set(nextKey,next);
        }
        break;
      }
      try{
        const result=await rawAiIndex(...entry.args);
        for(const waiter of entry.waiters)waiter.resolve(result);
      }catch(error){
        for(const waiter of entry.waiters)waiter.reject(error);
      }
    }
  }finally{
    flushingAi=false;
    if(!active()&&deferredAi.size)setTimeout(flushDeferredAi,0);
  }
}
function patchAi(){
  const ai=window.mochimonoAI;
  if(!ai?.index||aiPatched)return false;
  rawAiIndex=ai.index.bind(ai);
  ai.index=(...args)=>active()?deferAi(args):rawAiIndex(...args);
  aiPatched=true;
  return true;
}

async function flushDeferredCache(){
  cacheFlushTimer=0;
  if(active())return;
  const cache=window.mochimonoCatalogCache;
  if(!cache?.__performanceRawSave)return;
  if(pendingDimensions.size){
    const entries=[...pendingDimensions.values()];
    pendingDimensions.clear();
    for(const args of entries)cache.__performanceRawRemember(...args);
  }
  const pending=pendingCacheSave;
  pendingCacheSave=null;
  if(!pending)return;
  try{
    const result=await cache.__performanceRawSave(...pending.args);
    for(const waiter of pending.waiters)waiter.resolve(result);
  }catch(error){
    for(const waiter of pending.waiters)waiter.reject(error);
  }
}
function scheduleCacheFlush(){
  clearTimeout(cacheFlushTimer);
  cacheFlushTimer=setTimeout(()=>flushDeferredCache(),CACHE_FLUSH_DELAY_MS);
}

function patchCatalogCache(){
  const cache=window.mochimonoCatalogCache;
  if(!cache||cachePatched)return false;
  const rawSave=cache.save?.bind(cache),rawRemember=cache.rememberDimensions?.bind(cache);
  if(!rawSave||!rawRemember)return false;
  cache.__performanceRawSave=rawSave;
  cache.__performanceRawRemember=rawRemember;
  cache.save=(...args)=>{
    if(!active())return rawSave(...args);
    return new Promise((resolve,reject)=>{
      if(!pendingCacheSave)pendingCacheSave={args,waiters:[]};
      else pendingCacheSave.args=args;
      pendingCacheSave.waiters.push({resolve,reject});
    });
  };
  cache.rememberDimensions=(...args)=>{
    if(!active())return rawRemember(...args);
    const hash=String(args[0]||'');
    if(hash)pendingDimensions.set(hash,args);
  };
  cachePatched=true;
  return true;
}

function syncState(){
  patchExperimentalApi();
  patchCatalogCache();
  patchAi();
  const isActive=active();
  if(isActive&&!wasActive){
    clearTimeout(cacheFlushTimer);
    cacheFlushTimer=0;
    lastInteractionAt=now();
    window.mochimonoStableGrid?.release?.();
  }else if(!isActive&&wasActive){
    if(rerunPending)scheduleRerun();
    scheduleCacheFlush();
    scheduleQuietWaiters();
    setTimeout(flushDeferredAi,0);
  }
  wasActive=isActive;
}

new MutationObserver(syncState).observe(root,{attributes:true,attributeFilter:['class']});
queueMicrotask(syncState);
setTimeout(syncState,0);
addEventListener('mochimono:ai-ready',()=>{patchExperimentalApi();patchAi()},{passive:true});
