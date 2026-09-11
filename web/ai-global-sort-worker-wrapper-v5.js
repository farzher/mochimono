import { consolidateColorFamilies } from './ai-global-sort-family-postprocess.js?v=20260911-2';
let currentMode='';
let currentMedia=[];
const nativePost=self.postMessage.bind(self);
self.postMessage=message=>{
  if(currentMode!=='color'||message?.type!=='result'||!message?.result?.order)return nativePost(message);
  const base=message.result;
  const progress=(done,total,detail,stage)=>nativePost({type:'progress',done,total,detail,stage});
  consolidateColorFamilies(base,currentMedia,progress)
    .then(result=>nativePost({...message,result}))
    .catch(()=>nativePost(message));
};
await import('./ai-global-sort-worker-core-v5.js?v=20260911-1');
const baseHandler=self.onmessage;
self.onmessage=event=>{
  if(event.data?.action==='sort'){
    currentMode=String(event.data?.payload?.mode||'');
    currentMedia=Array.isArray(event.data?.payload?.media)?event.data.payload.media:[];
  }
  return baseHandler?.call(self,event);
};
