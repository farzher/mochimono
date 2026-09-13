const DB_NAME='mochimono-browser-folders';
const DB_VERSION=1;
const SOURCES='sources';
const FILES='files';
const inflight=new Map();
const browserFiles=new Map();

function openDb(){
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open(DB_NAME,DB_VERSION);
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
    request.onupgradeneeded=()=>{try{request.transaction.abort()}catch{};reject(new Error('Browser folder database is not ready'))};
  });
}

function firstRowForHash(db,hash){
  return new Promise(resolve=>{
    if(!db.objectStoreNames.contains(FILES))return resolve(null);
    const request=db.transaction(FILES,'readonly').objectStore(FILES).openCursor();
    request.onerror=()=>resolve(null);
    request.onsuccess=()=>{
      const cursor=request.result;
      if(!cursor)return resolve(null);
      if(String(cursor.value?.hash||'')===hash)return resolve(cursor.value);
      cursor.continue();
    };
  });
}

function sourceForId(db,id){
  return new Promise(resolve=>{
    if(!db.objectStoreNames.contains(SOURCES))return resolve(null);
    const request=db.transaction(SOURCES,'readonly').objectStore(SOURCES).get(id);
    request.onsuccess=()=>resolve(request.result||null);
    request.onerror=()=>resolve(null);
  });
}

async function fileAtPath(root,relative){
  const parts=String(relative||'').replaceAll('\\','/').split('/').filter(part=>part&&part!=='.'&&part!=='..');
  let handle=root;
  for(let index=0;index<parts.length;index++)handle=index===parts.length-1?await handle.getFileHandle(parts[index]):await handle.getDirectoryHandle(parts[index]);
  return handle?.getFile?.();
}

async function browserFileForHash(hash){
  if(browserFiles.has(hash))return browserFiles.get(hash);
  const pending=(async()=>{
    let db;
    try{
      db=await openDb();
      const row=await firstRowForHash(db,hash);
      if(!row)return null;
      const key=String(row.key||''),split=key.indexOf('\u0000');
      if(split<1)return null;
      const source=await sourceForId(db,key.slice(0,split));
      if(!source?.handle)return null;
      if(source.handle.queryPermission&&await source.handle.queryPermission({mode:'read'}).catch(()=> 'prompt')!=='granted')return null;
      return await fileAtPath(source.handle,row.path).catch(()=>null);
    }finally{db?.close?.()}
  })();
  browserFiles.set(hash,pending);
  return pending;
}

async function sourceBlob(record){
  const local=await browserFileForHash(String(record.hash));
  if(local)return local;
  const response=await fetch(`/api/objects/${encodeURIComponent(record.hash)}`,{cache:'force-cache'});
  if(!response.ok)throw new Error('HEIC source is unavailable');
  return response.blob();
}

function decodedResponse(response,edge){
  return response.blob().then(blob=>({
    blob,
    width:Number(response.headers.get('x-mochimono-width'))||0,
    height:Number(response.headers.get('x-mochimono-height'))||0,
    edge
  }));
}

export function heicViewBlob(record,edge=4096){
  if(!record?.hash)return Promise.reject(new Error('HEIC hash is required'));
  edge=Math.max(1024,Math.min(4096,Math.round(Number(edge)||4096)));
  const key=`${record.hash}:${edge}`;
  let pending=inflight.get(key);
  if(!pending){
    pending=(async()=>{
      const endpoint=`/api/client/browser-heic-thumb/${encodeURIComponent(record.hash)}?view=1&edge=${edge}`;
      const direct=await fetch(endpoint,{cache:'force-cache'}).catch(()=>null);
      if(direct?.ok)return decodedResponse(direct,edge);
      if(direct&&direct.status!==404){
        const data=await direct.json().catch(()=>({}));
        throw new Error(data.error||`HEIC decode failed (${direct.status})`);
      }

      const file=await sourceBlob(record);
      const response=await fetch(endpoint,{
        method:'PUT',
        headers:{'content-type':file.type||'image/heic'},
        body:file
      });
      if(!response.ok){
        const data=await response.json().catch(()=>({}));
        throw new Error(data.error||`HEIC decode failed (${response.status})`);
      }
      return decodedResponse(response,edge);
    })().finally(()=>{if(inflight.get(key)===pending)inflight.delete(key)});
    inflight.set(key,pending);
  }
  return pending;
}
