let child=null;
let canceled=false;
const GAP=.018;
const MIN_WORLD_WIDTH=12;
const MIN_LAYOUT_RATIO=.5;
const MAX_LAYOUT_RATIO=2;
const MAX_ROW_HEIGHT=1.08;
const post=(type,payload={})=>self.postMessage({type,...payload});
post('progress',{done:0,total:1,detail:'Starting tightly packed experimental layout…',stage:'startup'});

function ratio(item){
  const w=Math.max(1,Number(item?.width)||1),h=Math.max(1,Number(item?.height)||1);
  return w/h;
}
function layoutRatio(item){return Math.max(MIN_LAYOUT_RATIO,Math.min(MAX_LAYOUT_RATIO,ratio(item)))}
function fitAspect(item,boxW,boxH){
  const r=ratio(item),boxRatio=boxW/Math.max(.0001,boxH);
  return r>=boxRatio?[boxW,boxW/r]:[boxH*r,boxH];
}

function validIndexes(result,media){
  const out=[];
  for(let i=0;i<media.length;i++){
    const x=Number(result?.x?.[i]),y=Number(result?.y?.[i]);
    if(Number.isFinite(x)&&Number.isFinite(y)&&x>=0&&y>=0)out.push(i);
  }
  return out;
}

function makeRows(result,media,indexes,targetWidth){
  const ordered=indexes.slice().sort((a,b)=>(Number(result.y[a])-Number(result.y[b]))||(Number(result.x[a])-Number(result.x[b]))||a-b);
  const rows=[];
  let row=[],sum=0;
  const finish=()=>{if(!row.length)return;row.sort((a,b)=>(Number(result.x[a])-Number(result.x[b]))||(Number(result.y[a])-Number(result.y[b]))||a-b);rows.push(row);row=[];sum=0};
  for(const index of ordered){
    const r=layoutRatio(media[index]);
    if(row.length){
      const before=Math.abs(targetWidth-sum),after=Math.abs(targetWidth-(sum+r));
      if(sum>=targetWidth*.72&&after>before)finish();
    }
    row.push(index);sum+=r;
    if(sum>=targetWidth*1.08)finish();
  }
  finish();
  if(rows.length>1){
    const last=rows.at(-1),lastSum=last.reduce((s,i)=>s+layoutRatio(media[i]),0);
    if(lastSum<targetWidth*.36){
      const previous=rows[rows.length-2],merged=[...previous,...last].sort((a,b)=>(Number(result.y[a])-Number(result.y[b]))||(Number(result.x[a])-Number(result.x[b]))||a-b);
      let total=0;for(const i of merged)total+=layoutRatio(media[i]);
      let cut=1,running=0,best=Infinity;
      for(let i=0;i<merged.length-1;i++){running+=layoutRatio(media[merged[i]]);const error=Math.abs(running-total/2);if(error<best){best=error;cut=i+1}}
      rows.splice(rows.length-2,2,merged.slice(0,cut),merged.slice(cut));
    }
  }
  return rows;
}

function packRows(result,media,indexes){
  const totalRatio=indexes.reduce((sum,index)=>sum+layoutRatio(media[index]),0);
  const innerWidth=Math.max(MIN_WORLD_WIDTH,Math.sqrt(Math.max(1,totalRatio)));
  const rows=makeRows(result,media,indexes,innerWidth);
  const x=new Float32Array(media.length),y=new Float32Array(media.length),renderW=new Float32Array(media.length),renderH=new Float32Array(media.length);
  x.fill(-1);y.fill(-1);
  let top=.5;
  for(const row of rows){
    const sum=row.reduce((s,index)=>s+layoutRatio(media[index]),0),usable=Math.max(.1,innerWidth-GAP*Math.max(0,row.length-1));
    const height=Math.min(MAX_ROW_HEIGHT,usable/Math.max(.001,sum));
    let left=.5;
    for(const index of row){
      const boxW=layoutRatio(media[index])*height,boxH=height,[width,actualHeight]=fitAspect(media[index],boxW,boxH);
      const centerX=left+boxW/2,centerY=top+boxH/2;
      x[index]=centerX-.5;y[index]=centerY-.5;renderW[index]=width;renderH[index]=actualHeight;
      left+=boxW+GAP;
    }
    top+=height+GAP;
  }
  return{...result,x,y,renderW,renderH,worldW:innerWidth+1,worldH:Math.max(1,top-GAP+.5),labels:[],detail:`${result.detail||'Experimental map'} · tight aspect packing`};
}

function densify(result,media){
  if(result?.kind!=='map'||!result.x?.length||!result.y?.length)return result;
  const indexes=validIndexes(result,media);
  if(!indexes.length)return result;
  return packRows(result,media,indexes);
}

function run(payload){
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./experimental-layout-worker.js?v=20260912-7',self.location.href),{type:'module'});child=worker;
    let done=false;
    const finish=(fn,value)=>{if(done)return;done=true;if(child===worker)child=null;worker.terminate();fn(value)};
    worker.onerror=e=>finish(reject,new Error(e.message||'Experimental layout failed'));
    worker.onmessageerror=()=>finish(reject,new Error('Experimental layout returned unreadable data'));
    worker.onmessage=e=>{const data=e.data||{};if(data.type==='progress'){post('progress',data);return}if(data.type==='error')return finish(reject,new Error(data.error||'Experimental layout failed'));if(data.type==='result')finish(resolve(densify(data.result||{},payload.media||[])))};
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
    const transfer=[];for(const key of['order','x','y','renderW','renderH'])if(result[key]?.buffer)transfer.push(result[key].buffer);
    self.postMessage({type:'result',result},transfer);
  }catch(error){post('error',{error:String(error?.message||error),aborted:canceled})}
};
