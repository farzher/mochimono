import { heicViewBlob as fallbackHeicViewBlob } from './browser-thumbnail-fallback.js';

const inflight=new Map();

export function heicViewBlob(record,edge=4096){
  if(!record?.hash)return Promise.reject(new Error('HEIC hash is required'));
  edge=Math.max(1024,Math.min(4096,Math.round(Number(edge)||4096)));
  const key=`${record.hash}:${edge}`;
  let pending=inflight.get(key);
  if(!pending){
    pending=(async()=>{
      const direct=await fetch(`/api/client/browser-heic-thumb/${encodeURIComponent(record.hash)}?view=1&edge=${edge}`,{cache:'force-cache'}).catch(()=>null);
      if(direct?.ok){
        return{
          blob:await direct.blob(),
          width:Number(direct.headers.get('x-mochimono-width'))||0,
          height:Number(direct.headers.get('x-mochimono-height'))||0,
          edge
        };
      }
      if(direct&&direct.status!==404){
        const data=await direct.json().catch(()=>({}));
        throw new Error(data.error||`HEIC decode failed (${direct.status})`);
      }
      return fallbackHeicViewBlob(record,edge);
    })().finally(()=>{if(inflight.get(key)===pending)inflight.delete(key)});
    inflight.set(key,pending);
  }
  return pending;
}
