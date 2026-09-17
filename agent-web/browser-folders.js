import './storage-source-controls.js';

const folders = document.querySelector('#folders');
const frame = document.querySelector('#filesFrame');

if (folders) {
  const DB_NAME = 'mochimono-browser-folders';
  const DB_VERSION = 1;
  const SOURCES = 'sources';
  const FILES = 'files';
  let refreshTimer = 0;
  let enriching = false;
  let renderedKey = '';
  let apiPromise = null;
  let writingRows = false;
  let lastSources = [];
  const detailCache = new Map();
  const liveSyncs = new Map();

  const style = document.createElement('style');
  style.textContent = `.browser-folder-item .storage-meta:empty{display:none!important}`;
  document.head.append(style);

  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[char]));
  const normalize = source => source ? { ...source, scope:source.scope === 'all' ? 'all' : 'media', cloud:source.cloud === true } : source;

  function bytes(number) {
    const units=['B','KB','MB','GB','TB'];
    let value=Math.max(0,Number(number)||0),unit=0;
    while(value>=1000&&unit<units.length-1){value/=1000;unit++;}
    return `${value<10&&unit?value.toFixed(1):Math.round(value)} ${units[unit]}`;
  }

  function openDb() {
    return new Promise((resolve,reject)=>{
      const request=indexedDB.open(DB_NAME,DB_VERSION);
      request.onupgradeneeded=()=>{
        const db=request.result;
        if(!db.objectStoreNames.contains(SOURCES))db.createObjectStore(SOURCES,{keyPath:'id'});
        if(!db.objectStoreNames.contains(FILES))db.createObjectStore(FILES,{keyPath:'key'});
      };
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
    });
  }

  function getAll(store) {
    return new Promise((resolve,reject)=>{
      const request=store.getAll();
      request.onsuccess=()=>resolve(request.result||[]);
      request.onerror=()=>reject(request.error);
    });
  }

  async function readSources() {
    const db=await openDb();
    try{return (await getAll(db.transaction(SOURCES,'readonly').objectStore(SOURCES))).map(normalize);}
    finally{db.close();}
  }

  async function permission(handle) {
    if(!handle)return 'denied';
    if(!handle.queryPermission)return 'granted';
    return handle.queryPermission({mode:'read'}).catch(()=> 'prompt');
  }

  async function readDetails(sources) {
    const db=await openDb();
    let rows=[];
    try{rows=await getAll(db.transaction(FILES,'readonly').objectStore(FILES));}
    finally{db.close();}
    const groups=new Map(sources.map(source=>[String(source.id),[]]));
    for(const row of rows){
      const key=String(row?.key||''),split=key.indexOf('\u0000');
      if(split>0)groups.get(key.slice(0,split))?.push(row);
    }
    return Promise.all(sources.map(async source=>{
      const manifest=groups.get(String(source.id))||[];
      const previews=manifest
        .filter(row=>row.hash&&(String(row.mime||'').startsWith('image/')||String(row.mime||'').startsWith('video/')))
        .sort((a,b)=>Number(b.lastModified||0)-Number(a.lastModified||0))
        .slice(0,3)
        .map(row=>({hash:row.hash,mime:row.mime}));
      return {...source,permission:await permission(source.handle),files:manifest.length,bytes:manifest.reduce((sum,row)=>sum+(Number(row.size)||0),0),previews};
    }));
  }

  function pathParts(path) {
    const clean=String(path||'').replace(/[\\/]+$/,'');
    const index=Math.max(clean.lastIndexOf('\\'),clean.lastIndexOf('/'));
    if(index<0)return {parent:'',name:clean||path};
    return {parent:clean.slice(0,index+1),name:clean.slice(index+1)||clean};
  }

  function titleHtml(source) {
    const shown=source.rootPath||source.name;
    const {parent,name}=pathParts(shown);
    return `${parent?`<span class="storage-path-parent">${esc(parent)}</span>`:''}<b class="storage-path-name">${esc(name)}</b>`;
  }

  function previewCell(file,index) {
    if(!file)return `<span class="storage-folder-sample">${index===0?'<span class="sample-glyph">▱</span>':''}</span>`;
    const video=String(file.mime||'').startsWith('video/');
    return `<span class="storage-folder-sample ${video?'video':''}" data-preview-hash="${esc(file.hash)}"><span class="sample-glyph">${video?'▶':'▧'}</span><img src="/api/thumbs/${encodeURIComponent(file.hash)}" alt="" loading="eager" decoding="async" onload="this.parentElement.classList.add('thumb-ready')"></span>`;
  }

  function card(source) {
    const detail=detailCache.get(String(source.id))||source;
    const previews=detail.previews||[];
    const hasStats=Number.isFinite(detail.files);
    const meta=hasStats?`${Number(detail.files||0).toLocaleString()} files · ${bytes(detail.bytes)}`:'';
    const permissionState=detail.permission||'';
    const health=source.lastError?'bad':permissionState&&permissionState!=='granted'?'warn':permissionState==='granted'?'ok':'';
    const busy=liveSyncs.has(String(source.id));
    return `<article class="storage-item folder-item browser-folder-item${busy?' source-busy':''}" data-browser-folder="${esc(source.id)}" data-source-cloud="${source.cloud?'1':'0'}" data-source-scope="${esc(source.scope)}" data-source-health="${health}">
      <a class="storage-folder-samples storage-source-link" href="#" title="Library">${[0,1,2].map(index=>previewCell(previews[index],index)).join('')}</a>
      <div class="storage-copy"><div class="storage-title"><strong title="${esc(source.rootPath||source.name)}">${titleHtml(source)}</strong></div><div class="storage-meta">${meta?`<span>${esc(meta)}</span>`:''}</div></div>
      <div class="item-actions"><button class="icon tiny" data-browser-remove aria-label="Remove" title="Remove">×</button></div>
    </article>`;
  }

  function sourceKey(source) {
    const detail=detailCache.get(String(source.id));
    return [source.id,source.name,source.rootPath,source.scope,Boolean(source.cloud),source.lastError||'',detail?.permission||'',detail?.files??null,detail?.bytes??null,(detail?.previews||[]).map(item=>item.hash),liveSyncs.has(String(source.id))];
  }

  function render(sources) {
    lastSources=sources;
    const key=JSON.stringify(sources.map(sourceKey));
    if(key===renderedKey&&(!sources.length||folders.querySelector(':scope > [data-browser-folder]')))return;
    renderedKey=key;
    writingRows=true;
    for(const row of folders.querySelectorAll(':scope > [data-browser-folder]'))row.remove();
    if(sources.length){
      const holder=document.createElement('div');holder.innerHTML=sources.map(card).join('');folders.append(...holder.children);
    }
    requestAnimationFrame(()=>{writingRows=false;});
    window.mochimonoSourceControls?.refresh?.();
  }

  async function ensureApi() {
    if(window.mochimonoBrowserFolders)return window.mochimonoBrowserFolders;
    apiPromise ||= import('/files/browser-folder-sync.js').then(()=>{
      if(!window.mochimonoBrowserFolders)throw new Error('Browser folders unavailable');
      exposeToFrame();
      return window.mochimonoBrowserFolders;
    });
    return apiPromise;
  }

  function exposeToFrame() {
    const child=frame?.contentWindow;
    if(!child||!window.mochimonoBrowserFolders)return;
    try{child.mochimonoBrowserFolders=window.mochimonoBrowserFolders;}catch{}
  }

  function relay(name,detail) {
    exposeToFrame();
    try{frame?.contentWindow?.dispatchEvent(new CustomEvent(name,{detail}));}catch{}
  }

  async function refresh(enrich=true) {
    clearTimeout(refreshTimer);refreshTimer=0;
    let sources=[];
    try{sources=await readSources();}catch{return;}
    render(sources);
    if(sources.length)ensureApi().catch(()=>{});
    if(!enrich||enriching||!sources.length)return;
    enriching=true;
    try{
      const details=await readDetails(sources);
      for(const detail of details)detailCache.set(String(detail.id),detail);
      render(sources);
    }catch{}finally{enriching=false;}
  }

  function schedule(delay=0,enrich=true) {
    clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>refresh(enrich),Math.max(0,delay));
  }

  async function setCloud(id,enabled) {
    const api=await ensureApi();await api.setCloud(id,enabled);schedule(0,false);if(enabled)api.sync(id,{userGesture:true}).catch(()=>{});
  }
  async function setScope(id,scope) {
    const api=await ensureApi();await api.setScope(id,scope);schedule(0,false);api.sync(id,{userGesture:true}).catch(()=>{});
  }
  async function sync(id) { return (await ensureApi()).sync(id,{userGesture:true}); }

  function onSync(event) {
    const detail=event.detail||{},id=String(detail.id||'');if(!id)return;
    if(detail.state==='running')liveSyncs.set(id,detail);else liveSyncs.delete(id);
    relay('mochimono:browser-folder-sync',detail);
    schedule(detail.state==='running'?0:30,detail.state!=='running');
  }
  function onThumbnail(event){relay('mochimono:browser-thumbnail-ready',event.detail||{});}
  function onChanged(event){relay('mochimono:browser-folders-changed',event.detail||{});schedule(0,true);}
  function onReady(event){exposeToFrame();relay('mochimono:browser-folders-ready',event.detail||{});}

  window.addEventListener('mochimono:browser-folder-sync',onSync);
  window.addEventListener('mochimono:browser-thumbnail-ready',onThumbnail);
  window.addEventListener('mochimono:browser-folders-changed',onChanged);
  window.addEventListener('mochimono:browser-folders-ready',onReady);

  folders.addEventListener('click',async event=>{
    const remove=event.target.closest('[data-browser-remove]');if(!remove)return;
    const row=remove.closest('[data-browser-folder]'),id=row?.dataset.browserFolder;if(!id)return;
    remove.disabled=true;
    try{await (await ensureApi()).remove(id);detailCache.delete(id);schedule(0,true);}catch{}finally{remove.disabled=false;}
  },true);

  new MutationObserver(records=>{
    if(writingRows||!lastSources.length)return;
    if(records.some(record=>record.addedNodes.length||record.removedNodes.length)&&!folders.querySelector(':scope > [data-browser-folder]')){renderedKey='';render(lastSources);}
  }).observe(folders,{childList:true});

  frame?.addEventListener('load',()=>{exposeToFrame();});
  window.mochimonoBrowserFolderShell={setCloud,setScope,sync,refresh:()=>schedule(0,true),activate:ensureApi};
  schedule(0,true);
}
