import { ensureBrowserThumbnail, heicThumbUrl, isHeicRecord } from './browser-thumbnail-fallback.js';
import { heicViewBlob } from './heic-view.js';

const files=document.querySelector('#files');
const viewer=document.querySelector('#viewer');
const viewerMedia=document.querySelector('#viewer-media');
const viewerName=document.querySelector('#viewer-name');
const viewerOpen=document.querySelector('#viewer-open');
const repairing=new Map();
const repaired=new Set();
const failedUntil=new Map();
let scanTimer=0,viewerDecodedUrl='',viewerDecodedHash='',viewerLoadingHash='',viewerDecodeToken=0;

const HEIC_RE=/\.(?:heic|heif)$/i;
const validHash=value=>/^[a-f0-9]{64}$/.test(String(value||''));
const record=(hash,filename='',width=0,height=0)=>({hash:String(hash||''),filename:String(filename||''),mime:'image/heic',kind:'image',type:'image',width:Number(width)||0,height:Number(height)||0,urgent:true});

function cardRecord(card){
  const hash=String(card?.dataset?.hash||''),filename=String(card?.dataset?.filename||card?.title||'');
  return validHash(hash)&&HEIC_RE.test(filename)?record(hash,filename,card.dataset.width,card.dataset.height):null;
}

function visible(card,margin=900){
  const rect=card.getBoundingClientRect();
  return rect.bottom>=-margin&&rect.top<=innerHeight+margin&&rect.right>=-margin&&rect.left<=innerWidth+margin;
}

function openDb(name,version){
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open(name,version);
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
    request.onupgradeneeded=()=>{try{request.transaction.abort()}catch{}};
  });
}

const txDone=tx=>new Promise((resolve,reject)=>{
  tx.oncomplete=resolve;
  tx.onerror=()=>reject(tx.error);
  tx.onabort=()=>reject(tx.error||new Error('IndexedDB transaction aborted'));
});

async function invalidateVisual(hash){
  let db;
  try{
    db=await openDb('mochimono-visual-similarity',1);
    if(!db.objectStoreNames.contains('fingerprints'))return;
    const tx=db.transaction('fingerprints','readwrite');
    tx.objectStore('fingerprints').delete(hash);
    await txDone(tx);
  }catch{}finally{db?.close?.()}
}

async function deleteIndexedHash(store,hash){
  if(!store.indexNames.contains('hash'))return;
  await new Promise((resolve,reject)=>{
    const request=store.index('hash').openCursor(IDBKeyRange.only(hash));
    request.onerror=()=>reject(request.error);
    request.onsuccess=()=>{
      const cursor=request.result;
      if(!cursor)return resolve();
      cursor.delete();cursor.continue();
    };
  });
}

async function invalidateAi(hash){
  let db;
  try{
    db=await openDb('mochimono-ai',2);
    const names=['embeddings','metadata'].filter(name=>db.objectStoreNames.contains(name));
    if(!names.length)return;
    const tx=db.transaction(names,'readwrite');
    await Promise.all(names.map(name=>deleteIndexedHash(tx.objectStore(name),hash)));
    await txDone(tx);
  }catch{}finally{db?.close?.()}
}

function invalidateIndexesLater(hash){
  const run=()=>Promise.all([invalidateVisual(hash),invalidateAi(hash)]).catch(()=>{});
  if('requestIdleCallback'in window)requestIdleCallback(run,{timeout:5000});
  else setTimeout(run,1000);
}

function refreshImages(hash){
  const src=heicThumbUrl(hash),absolute=new URL(src,location.href).href;
  for(const card of document.querySelectorAll(`#files [data-hash="${CSS.escape(hash)}"]`)){
    const image=card.querySelector('img');
    if(image&&image.src!==absolute)image.src=src;
  }
}

async function refreshLegacyThumbCache(hash){
  const response=await fetch(`/api/thumbs/${encodeURIComponent(hash)}?v=3`,{cache:'reload'}).catch(()=>null);
  if(!response?.ok)return false;
  await response.blob().catch(()=>null);
  return true;
}

async function repair(item){
  if(!item||!validHash(item.hash)||!isHeicRecord(item))return null;
  if(repaired.has(item.hash)){refreshImages(item.hash);return null}
  if((failedUntil.get(item.hash)||0)>Date.now())return null;
  let pending=repairing.get(item.hash);
  if(!pending){
    pending=ensureBrowserThumbnail(item).then(async result=>{
      repaired.add(item.hash);
      failedUntil.delete(item.hash);
      if(result?.width&&!item.width)item.width=result.width;
      if(result?.height&&!item.height)item.height=result.height;
      await refreshLegacyThumbCache(item.hash);
      refreshImages(item.hash);
      invalidateIndexesLater(item.hash);
      window.dispatchEvent(new CustomEvent('mochimono:browser-thumbnail-ready',{detail:{hash:item.hash,...(result||{})}}));
      window.dispatchEvent(new CustomEvent('mochimono:heic-repaired',{detail:{hash:item.hash,filename:item.filename,...(result||{})}}));
      return result;
    }).catch(error=>{
      failedUntil.set(item.hash,Date.now()+15000);
      throw error;
    }).finally(()=>{
      if(repairing.get(item.hash)===pending)repairing.delete(item.hash);
    });
    repairing.set(item.hash,pending);
  }
  return pending;
}

function scan(){
  scanTimer=0;
  if(document.hidden||!files)return;
  for(const card of files.querySelectorAll('[data-hash]')){
    const item=cardRecord(card);
    if(item&&visible(card))repair(item).catch(()=>{});
  }
}

function scheduleScan(delay=60){
  clearTimeout(scanTimer);
  scanTimer=setTimeout(scan,delay);
}

function viewerRecord(){
  const filename=String(viewerName?.textContent||'');
  if(!HEIC_RE.test(filename))return null;
  const hash=String(viewerOpen?.getAttribute('href')||'').match(/\/api\/objects\/([a-f0-9]{64})/)?.[1]||'';
  return validHash(hash)?record(hash,filename):null;
}

function clearViewerDecoded(){
  viewerDecodeToken++;
  viewerLoadingHash='';
  if(viewerDecodedUrl)URL.revokeObjectURL(viewerDecodedUrl);
  viewerDecodedUrl='';
  viewerDecodedHash='';
}

async function repairViewer(){
  if(viewer?.hidden){clearViewerDecoded();return}
  const item=viewerRecord(),image=viewerMedia?.querySelector(':scope > img');
  if(!item||!image){clearViewerDecoded();return}
  if(viewerDecodedHash===item.hash&&viewerDecodedUrl&&image.src===viewerDecodedUrl)return;
  if(viewerLoadingHash===item.hash)return;

  const token=++viewerDecodeToken;
  viewerLoadingHash=item.hash;
  image.removeAttribute('data-full-src');
  image.dataset.browserSourceHash=item.hash;
  image.dataset.heicDecoded='1';
  image.onerror=null;
  const thumb=heicThumbUrl(item.hash),absoluteThumb=new URL(thumb,location.href).href;
  if(image.src!==absoluteThumb)image.src=thumb;

  const edge=Math.max(2048,Math.min(4096,Math.ceil(Math.max(innerWidth,innerHeight)*(devicePixelRatio||1)*1.5)));
  try{
    const decoded=await heicViewBlob(item,edge);
    if(viewer?.hidden||viewerRecord()?.hash!==item.hash||!image.isConnected||token!==viewerDecodeToken)return;
    if(viewerDecodedUrl)URL.revokeObjectURL(viewerDecodedUrl);
    viewerDecodedUrl=URL.createObjectURL(decoded.blob);
    viewerDecodedHash=item.hash;
    image.src=viewerDecodedUrl;
  }catch{}finally{
    if(token===viewerDecodeToken&&viewerLoadingHash===item.hash)viewerLoadingHash='';
  }
}

if(files){
  new MutationObserver(()=>scheduleScan()).observe(files,{childList:true,subtree:true});
  addEventListener('scroll',()=>scheduleScan(90),{passive:true});
  addEventListener('resize',()=>scheduleScan(90),{passive:true});
  addEventListener('mochimono:grid-model',()=>scheduleScan(20));
  scheduleScan(200);
}

addEventListener('mochimono:heic-needs-repair',event=>{
  const detail=event.detail||{};
  const item=record(detail.hash,detail.filename,detail.width,detail.height);
  if(validHash(item.hash)&&HEIC_RE.test(item.filename))repair(item).catch(()=>{});
});

if(viewer&&viewerMedia&&viewerName&&viewerOpen){
  const sync=()=>queueMicrotask(()=>repairViewer().catch(()=>{}));
  new MutationObserver(sync).observe(viewerMedia,{childList:true,subtree:true,attributes:true,attributeFilter:['src','data-full-src']});
  new MutationObserver(sync).observe(viewer,{attributes:true,attributeFilter:['hidden']});
  new MutationObserver(sync).observe(viewerName,{childList:true,characterData:true,subtree:true});
  new MutationObserver(sync).observe(viewerOpen,{attributes:true,attributeFilter:['href']});
}
