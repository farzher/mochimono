let child = null;
let canceled = false;
const ITEM_SIDE = .96;
const GUTTER = .045;
const SEMANTIC_GAP = .12;
const post = (type,payload={}) => self.postMessage({type,...payload});
post('progress',{done:0,total:1,detail:'Starting dense experimental layout…',stage:'startup'});

function extent(item) {
  const w=Math.max(1,Number(item?.width)||1),h=Math.max(1,Number(item?.height)||1),r=w/h;
  return r>=1?[ITEM_SIDE,ITEM_SIDE/r]:[ITEM_SIDE*r,ITEM_SIDE];
}

const q = value => Math.round(Number(value)*10000)/10000;

function axisLayout(coords, extents) {
  const groups=new Map();
  for(let i=0;i<coords.length;i++){
    const value=Number(coords[i]);
    if(!Number.isFinite(value)||value<0)continue;
    const key=q(value);
    const size=Math.max(.02,Number(extents[i])||ITEM_SIDE);
    const current=groups.get(key);
    if(!current||size>current.extent)groups.set(key,{old:key,extent:size});
  }
  const list=[...groups.values()].sort((a,b)=>a.old-b.old);
  if(!list.length)return{origin:value=>Number(value)||0,range:(start,length)=>({start:Number(start)||0,size:Math.max(.05,Number(length)||1)}),size:1};
  let center=.5+list[0].extent/2;
  list[0].center=center;
  for(let i=1;i<list.length;i++){
    const prev=list[i-1],cur=list[i],oldGap=Math.max(0,cur.old-prev.old-1);
    const gap=GUTTER+Math.min(.38,oldGap*SEMANTIC_GAP);
    center+=prev.extent/2+cur.extent/2+gap;
    cur.center=center;
  }
  const byKey=new Map(list.map(item=>[item.old,item]));
  const origin=value=>{
    const old=q(value),exact=byKey.get(old);
    if(exact)return exact.center-.5;
    let lo=0,hi=list.length-1;
    while(lo<=hi){const mid=(lo+hi)>>1;if(list[mid].old<old)lo=mid+1;else hi=mid-1}
    if(lo<=0)return list[0].center-.5;
    if(lo>=list.length)return list.at(-1).center-.5;
    const a=list[lo-1],b=list[lo],t=(old-a.old)/(b.old-a.old||1);
    return a.center+(b.center-a.center)*t-.5;
  };
  const range=(start,length)=>{
    const a=Number(start)||0,b=a+Math.max(.001,Number(length)||1);
    const selected=list.filter(item=>item.old>=a-1e-4&&item.old<b-1e-4);
    if(!selected.length){const x=origin(a)+.5;return{start:x-.12,size:.24}}
    const first=selected[0],last=selected.at(-1),left=first.center-first.extent/2-GUTTER/2,right=last.center+last.extent/2+GUTTER/2;
    return{start:left,size:Math.max(.08,right-left)};
  };
  return{origin,range,size:list.at(-1).center+list.at(-1).extent/2+.5};
}

function denseAtlas(result,media) {
  const rows=new Map();
  for(let i=0;i<result.x.length;i++){
    const x=Number(result.x[i]),y=Number(result.y[i]);
    if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0)continue;
    const key=q(y);let row=rows.get(key);if(!row)rows.set(key,row=[]);row.push(i);
  }
  const ordered=[...rows.entries()].sort((a,b)=>a[0]-b[0]);
  if(!ordered.length)return result;
  const data=ordered.map(([oldY,indexes])=>{
    indexes.sort((a,b)=>Number(result.x[a])-Number(result.x[b]));
    let width=0,height=.02,center=0;
    for(let k=0;k<indexes.length;k++){
      const [w,h]=extent(media[indexes[k]]);width+=w+(k?GUTTER:0);height=Math.max(height,h);center+=(Number(result.x[indexes[k]])+.5);
    }
    return{oldY,indexes,width,height,oldCenter:center/indexes.length};
  });
  const innerW=Math.max(...data.map(row=>row.width));
  const worldW=innerW+1;
  let cy=.5+data[0].height/2;
  data[0].cy=cy;
  for(let r=1;r<data.length;r++){
    const prev=data[r-1],row=data[r],oldGap=Math.max(0,row.oldY-prev.oldY-1);
    const gap=GUTTER+Math.min(.3,oldGap*SEMANTIC_GAP);
    cy+=prev.height/2+row.height/2+gap;row.cy=cy;
  }
  const x=new Float32Array(result.x.length),y=new Float32Array(result.y.length);x.fill(-1);y.fill(-1);
  const oldW=Math.max(1,Number(result.worldW)||1);
  for(const row of data){
    const ratio=Math.max(0,Math.min(1,row.oldCenter/oldW));
    const minCenter=.5+row.width/2,maxCenter=worldW-.5-row.width/2;
    const target=Math.max(minCenter,Math.min(maxCenter,.5+ratio*(worldW-1)));
    let cursor=target-row.width/2;
    for(const index of row.indexes){
      const [w]=extent(media[index]);const center=cursor+w/2;x[index]=center-.5;y[index]=row.cy-.5;cursor+=w+GUTTER;
    }
  }
  const worldH=data.at(-1).cy+data.at(-1).height/2+.5;
  return{...result,x,y,worldW,worldH,labels:[],detail:`${result.detail||'AI Atlas'} · aspect-dense packing`};
}

function denseAxes(result,media) {
  const xExtent=new Float32Array(media.length),yExtent=new Float32Array(media.length);
  for(let i=0;i<media.length;i++){const [w,h]=extent(media[i]);xExtent[i]=w;yExtent[i]=h}
  const tx=axisLayout(result.x,xExtent),ty=axisLayout(result.y,yExtent);
  const x=new Float32Array(result.x.length),y=new Float32Array(result.y.length);x.fill(-1);y.fill(-1);
  for(let i=0;i<x.length;i++){
    const px=Number(result.x[i]),py=Number(result.y[i]);
    if(Number.isFinite(px)&&px>=0)x[i]=tx.origin(px);
    if(Number.isFinite(py)&&py>=0)y[i]=ty.origin(py);
  }
  const labels=(result.labels||[]).map(entry=>{
    const xr=tx.range(entry.x,entry.w),yr=ty.range(entry.y,entry.h);
    return{...entry,x:xr.start,y:yr.start,w:xr.size,h:yr.size};
  });
  return{...result,x,y,worldW:tx.size,worldH:ty.size,labels,detail:`${result.detail||'Experimental map'} · aspect-dense packing`};
}

function densify(result,media,mode) {
  if(result?.kind!=='map'||!result.x?.length||!result.y?.length)return result;
  return mode==='atlas'&&!result.labels?.length?denseAtlas(result,media):denseAxes(result,media);
}

function run(payload){
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./experimental-layout-worker.js?v=20260912-4',self.location.href),{type:'module'});child=worker;
    let done=false;
    const finish=(fn,value)=>{if(done)return;done=true;if(child===worker)child=null;worker.terminate();fn(value)};
    worker.onerror=e=>finish(reject,new Error(e.message||'Experimental layout failed'));
    worker.onmessageerror=()=>finish(reject,new Error('Experimental layout returned unreadable data'));
    worker.onmessage=e=>{const data=e.data||{};if(data.type==='progress'){post('progress',data);return}if(data.type==='error')return finish(reject,new Error(data.error||'Experimental layout failed'));if(data.type==='result')finish(resolve,densify(data.result||{},payload.media||[],String(payload?.mode||'')))};
    worker.postMessage({action:'build',payload});
  });
}

self.onmessage=async event=>{
  const data=event.data||{};
  if(data.action==='cancel'){canceled=true;child?.terminate();child=null;return}
  if(data.action!=='build')return;
  canceled=false;
  try{
    const result=await run(data.payload||{});
    if(canceled)return;
    const transfer=[];for(const key of['order','x','y'])if(result[key]?.buffer)transfer.push(result[key].buffer);
    self.postMessage({type:'result',result},transfer);
  }catch(error){post('error',{error:String(error?.message||error),aborted:canceled})}
};
