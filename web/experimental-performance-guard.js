const root=document.documentElement;
const ACTIVE='experimental-view-active';
const RERUN_QUIET_MS=700;
const AI_QUIET_MS=900;
let lastInteractionAt=0;
let rerunTimer=0;
let rerunPending=false;
let rawRerun=null;
let cachePatched=false;
let aiPatched=false;
let wasActive=false;
let pendingCacheSaves=[];
let pendingDimensions=new Map();

const active=()=>root.classList.contains(ACTIVE);
const now=()=>performance.now();
function markInteraction(){if(active())lastInteractionAt=now()}
addEventListener('wheel',markInteraction,{capture:true,passive:true});
addEventListener('pointerdown',markInteraction,{capture:true,passive:true});
addEventListener('pointermove',markInteraction,{capture:true,passive:true});

function quietFor(ms=RERUN_QUIET_MS){return !active()||now()-lastInteractionAt>=ms}
function waitForQuiet(ms){
  if(quietFor(ms))return Promise.resolve();
  return new Promise(resolve=>{
    const check=()=>{
      if(quietFor(ms)){resolve();return}
      setTimeout(check,Math.max(40,ms-(now()-lastInteractionAt)));
    };
    check();
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
  api.waitForQuiet=(ms=RERUN_QUIET_MS)=>waitForQuiet(Math.max(0,Number(ms)||0));
  api.__performanceGuard=true;
  return true;
}

function patchAi(){
  const ai=window.mochimonoAI;
  if(!ai?.index||aiPatched)return false;
  const rawIndex=ai.index.bind(ai);
  ai.index=async(...args)=>{
    if(active())await waitForQuiet(AI_QUIET_MS);
    return rawIndex(...args);
  };
  aiPatched=true;
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
  patchAi();
  const isActive=active();
  if(isActive&&!wasActive){
    lastInteractionAt=now();
    window.mochimonoStableGrid?.release?.();
  }else if(!isActive&&wasActive){
    if(rerunPending)scheduleRerun();
    flushDeferredCache();
  }
  wasActive=isActive;
}

new MutationObserver(syncState).observe(root,{attributes:true,attributeFilter:['class']});
queueMicrotask(syncState);
addEventListener('mochimono:ai-ready',()=>{patchExperimentalApi();patchAi()},{passive:true});
