let activeMode='';
const nativePostMessage=self.postMessage.bind(self);
self.postMessage=message=>{
  if(activeMode==='color'&&message?.type==='result'&&Array.isArray(message.result?.order)&&Array.isArray(message.result?.rail)){
    const result=message.result;
    const rail=result.rail;
    const neutral=rail.find(entry=>String(entry?.label||'')==='Neutral');
    const next=neutral?rail.filter(entry=>Number(entry?.index)>Number(neutral.index)).sort((a,b)=>Number(a.index)-Number(b.index))[0]:null;
    const cut=neutral&&Number(neutral.index)===0&&next?Math.max(0,Math.min(result.order.length,Number(next.index)||0)):0;
    if(cut>0){
      const body=result.order.slice(cut);
      const neutralTail=result.order.slice(0,cut).reverse();
      result.order=body.concat(neutralTail);
      result.rail=rail
        .filter(entry=>String(entry?.label||'')!=='Neutral'&&Number(entry?.index)>=cut)
        .map(entry=>({...entry,index:Number(entry.index)-cut}));
      result.rail.push({index:body.length,label:'Neutral'});
    }
  }
  return nativePostMessage(message);
};
await import('./ai-global-sort-worker-core-v4.js?v=20260911-10');
const baseHandler=self.onmessage;
self.onmessage=event=>{
  activeMode=String(event.data?.payload?.mode||'');
  return baseHandler?.call(self,event);
};
