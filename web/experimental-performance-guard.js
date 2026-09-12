const root=document.documentElement;
const ACTIVE='experimental-view-active';
const RERUN_QUIET_MS=700;
let lastInteractionAt=0;
let rerunTimer=0;
let rerunPending=false;
let rawRerun=null;
let cachePatched=false;
let pendingCacheSaves=[];
let pendingDimensions=new Map();

const active=()=>root.classList.contains(ACTIVE);
const now=()=>performance.now();
function markInteraction(){if(active())lastInteractionAt=now()}
addEventListener('wheel',markInteraction,{capture:true,passive:true});
addEventListener('pointerdown',markInteraction,{capture:true,passive:true});
addEventListener('pointermove',markInteraction,{capture:true,passive:true});

function quietFor(ms=RERUN_QUIET_MS){return !active()||now()-lastInteractionAt>=ms}
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
  api.__performanceGuard=true;
  return true;
}

async function flushDeferredCache(){
  if(active())return;
  const cache=window.mochimonoCatalogCache;
  if(!cache?.__performanceRawSave)return;
  if(pendingDimensions.size){
    const entries=[...pendingDimensions.values()];
    pendingDimensions.clear();
    for(const args of entries)cache.__performanceRawRemember(...args);
  }
  const saves=pendingCacheSaves;
  pendingCacheSaves=[];
  for(const item of saves){
    try{item.resolve(await cache.__performanceRawSave(...item.args))}
    catch(error){item.reject(error)}
  }
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
    return new Promise((resolve,reject)=>pendingCacheSaves.push({args,resolve,reject}));
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
  if(active()){
    lastInteractionAt=now();
    window.mochimonoStableGrid?.release?.();
  }else{
    if(rerunPending)scheduleRerun();
    flushDeferredCache();
  }
}

new MutationObserver(syncState).observe(root,{attributes:true,attributeFilter:['class']});
queueMicrotask(syncState);
addEventListener('mochimono:ai-ready',()=>patchExperimentalApi(),{passive:true});
