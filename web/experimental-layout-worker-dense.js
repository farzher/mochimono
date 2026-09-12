let child=null;
let canceled=false;
const GAP=.018;
const MIN_WORLD_WIDTH=12;
const MIN_LAYOUT_RATIO=.5;
const MAX_LAYOUT_RATIO=2;
const MAX_ROW_HEIGHT=1.08;
const VIS_DB='mochimono-visual-similarity',VIS_VERSION=1,VIS_STORE='fingerprints';
const AI_DB='mochimono-ai',AI_VERSION=2,EMBEDDINGS='embeddings',EMBED_SCHEMA=3,DINO_VERSION='dinov3-vitb16-v2';
const DINO_DIM=24,HASH_RE=/^[a-f0-9]{64}$/;
const post=(type,payload={})=>self.postMessage({type,...payload});
const abort=()=>{if(canceled)throw new DOMException('Aborted','AbortError')};
const clamp=(value,low=0,high=1)=>Math.max(low,Math.min(high,value));
post('progress',{done:0,total:1,detail:'Starting tightly packed experimental layout…',stage:'startup'});

function ratio(item){
  const w=Math.max(1,Number(item?.width)||1),h=Math.max(1,Number(item?.height)||1);
  return w/h;
}
function layoutRatio(item){return Math.max(MIN_LAYOUT_RATIO,Math.min(MAX_LAYOUT_RATIO,ratio(item)))}
function fitAspect(item,boxW,boxH){
  const r=layoutRatio(item),boxRatio=boxW/Math.max(.0001,boxH);
  return r>=boxRatio?[boxW,boxW/r]:[boxH*r,boxH];
}
function openDb(name,version){return new Promise((resolve,reject)=>{const request=indexedDB.open(name,version);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)})}
function normalize(data,offset=0,dim=data.length){let n=0;for(let i=0;i<dim;i++)n+=data[offset+i]*data[offset+i];n=Math.sqrt(n)||1;for(let i=0;i<dim;i++)data[offset+i]/=n;return data}
const projectionMaps=new Map();
function projectionMap(length,dim){const key=`${length}:${dim}`;if(projectionMaps.has(key))return projectionMaps.get(key);const a=new Uint16Array(length),b=new Uint16Array(length),s=new Int8Array(length*2);for(let i=0;i<length;i++){const x=Math.imul(i+1,0x9e3779b1)>>>0,y=Math.imul(i+17,0x85ebca6b)>>>0;a[i]=x%dim;b[i]=y%dim;s[i*2]=(x&0x80000000)?-1:1;s[i*2+1]=(y&0x40000000)?-1:1}const map={a,b,s};projectionMaps.set(key,map);return map}
function project(source,target,offset,dim){const map=projectionMap(source.length,dim);for(let i=0;i<source.length;i++){const value=Number(source[i])||0;target[offset+map.a[i]]+=value*map.s[i*2];target[offset+map.b[i]]+=value*map.s[i*2+1]}normalize(target,offset,dim)}
function hashNoise(value){let hash=2166136261;for(let i=0;i<value.length;i++){hash^=value.charCodeAt(i);hash=Math.imul(hash,16777619)}return(hash>>>0)/4294967295}
function circularHueDistance(a,b){const d=Math.abs(a-b);return Math.min(d,1-d)}

function colorFeatures(count){return{available:new Uint8Array(count),h:new Float32Array(count),l:new Float32Array(count),c:new Float32Array(count),f:new Float32Array(count)}}
function rowColor(row){const flow=row?.aiColorFlow;if(flow&&Number.isFinite(Number(flow.l))){return{h:((Number(flow.h)||0)%1+1)%1,l:clamp(Number(flow.l)||0),c:Math.max(0,Number(flow.c)||0),f:clamp(Number(flow.f)||0)}}const color=row?.visualColor,feature=row?.visualFeature;if(!color&&!feature)return null;return{h:((Number(color?.dominantHue)||0)%1+1)%1,l:clamp((Number(feature?.meanLuma)||127)/255),c:Math.max(0,Number(color?.meanChroma)||0),f:clamp(Number(color?.colorFraction)||0)}}
async function loadColors(media,byHash){const out=colorFeatures(media.length);let db;try{db=await openDb(VIS_DB,VIS_VERSION);if(!db.objectStoreNames.contains(VIS_STORE))return out;post('progress',{done:0,total:media.length,detail:'Reading perceptual OKLab color…',stage:'visual'});const request=db.transaction(VIS_STORE,'readonly').objectStore(VIS_STORE).openCursor();let found=0;await new Promise((resolve,reject)=>{request.onerror=()=>reject(request.error);request.onsuccess=()=>{abort();const cursor=request.result;if(!cursor)return resolve();const row=cursor.value||{},index=byHash.get(String(row.hash||''));if(index!=null){const color=rowColor(row);if(color){out.available[index]=1;out.h[index]=color.h;out.l[index]=color.l;out.c[index]=color.c;out.f[index]=color.f;found++}}if(found&&found%5000===0)post('progress',{done:found,total:media.length,detail:`Reading perceptual OKLab color · ${found.toLocaleString()} matched…`,stage:'visual'});cursor.continue()}});return out}catch{return out}finally{db?.close?.()}}
function dinoSpace(count){return{available:new Uint8Array(count),data:new Float32Array(count*DINO_DIM),loaded:0}}
async function loadDino(media,byHash){const out=dinoSpace(media.length);let db;try{db=await openDb(AI_DB,AI_VERSION);if(!db.objectStoreNames.contains(EMBEDDINGS))return out;const store=db.transaction(EMBEDDINGS,'readonly').objectStore(EMBEDDINGS);if(!store.indexNames.contains('model'))return out;post('progress',{done:0,total:media.length,detail:'Reading visual AI for local neighborhoods…',stage:'embeddings'});const request=store.index('model').openCursor(IDBKeyRange.only(DINO_VERSION));await new Promise((resolve,reject)=>{request.onerror=()=>reject(request.error);request.onsuccess=()=>{abort();const cursor=request.result;if(!cursor)return resolve();const row=cursor.value||{},index=byHash.get(String(row.hash||''));if(index!=null&&Number(row.schema)===EMBED_SCHEMA&&row.vector?.length){project(row.vector,out.data,index*DINO_DIM,DINO_DIM);out.available[index]=1;out.loaded++;if(out.loaded%5000===0)post('progress',{done:out.loaded,total:media.length,detail:`Reading visual AI · ${out.loaded.toLocaleString()} matched…`,stage:'embeddings'})}cursor.continue()}});return out}catch{return out}finally{db?.close?.()}}
function dinoDist(dino,a,b){if(!dino.available[a]||!dino.available[b])return 1;let dot=0,ao=a*DINO_DIM,bo=b*DINO_DIM;for(let d=0;d<DINO_DIM;d++)dot+=dino.data[ao+d]*dino.data[bo+d];return clamp(1-dot,0,2)}
function neutralAt(colors,index){return!colors.available[index]||colors.c[index]<.022||colors.f[index]<.10}
function localColorDist(colors,a,b){if(!colors.available[a]||!colors.available[b])return 1;const na=neutralAt(colors,a),nb=neutralAt(colors,b),light=Math.abs(colors.l[a]-colors.l[b]),chroma=Math.min(1,Math.abs(colors.c[a]-colors.c[b])*5);let hue=0;if(!na&&!nb){const strength=Math.min(1,(colors.c[a]+colors.c[b])*5);hue=circularHueDistance(colors.h[a],colors.h[b])*(.35+.65*strength)}else if(na!==nb)hue=.32;return clamp(light*.48+hue*.82+chroma*.16,0,1.5)}
function localDist(colors,dino,a,b){const color=localColorDist(colors,a,b);return dino.available[a]&&dino.available[b]?dinoDist(dino,a,b)*.62+color*.38:color}
function hueSeam(colors){const bins=48,hist=new Float64Array(bins);let total=0;for(let i=0;i<colors.available.length;i++){if(neutralAt(colors,i))continue;const weight=(.12+Math.min(1,colors.c[i]*7))*(.25+.75*colors.f[i]);hist[Math.min(bins-1,Math.floor(colors.h[i]*bins))]+=weight;total+=weight}if(total<=0)return 0;let best=0,bestScore=Infinity;for(let b=0;b<bins;b++){const score=hist[(b+bins-2)%bins]*.3+hist[(b+bins-1)%bins]*.75+hist[b]*1.2+hist[(b+1)%bins]*.75+hist[(b+2)%bins]*.3;if(score<bestScore){bestScore=score;best=b}}return(best+.5)/bins}
function orderColorRow(items,rowIndex,cols,targetX,targetY,colors,dino,above){const base=items.slice().sort((a,b)=>targetX[a]-targetX[b]||targetY[a]-targetY[b]||a-b),pool=[],placed=[];let cursor=0;const window=Math.min(18,Math.max(8,Math.ceil(Math.sqrt(base.length))));while(placed.length<base.length){abort();while(cursor<base.length&&pool.length<window)pool.push(base[cursor++]);const col=placed.length,position=base.length<=1?.5:col/(base.length-1),left=placed.length?placed.at(-1):-1,up=above?.[col]??-1;let best=0,bestScore=Infinity;for(let p=0;p<pool.length;p++){const candidate=pool[p];let score=Math.abs(targetX[candidate]-position)*3.8;if(left>=0)score+=localDist(colors,dino,left,candidate)*.72;if(up>=0)score+=localDist(colors,dino,up,candidate)*.48;if(neutralAt(colors,candidate)){const outside=Math.max(0,Math.abs(position-.5)-.16);score+=outside*4.5}if(score<bestScore){bestScore=score;best=p}}placed.push(pool.splice(best,1)[0])}return placed}
async function beautifulColorMap(media){const usable=Array.isArray(media)?media.filter(item=>HASH_RE.test(String(item?.hash||''))):[];if(!usable.length)return{kind:'map',x:new Float32Array(),y:new Float32Array(),worldW:1,worldH:1,labels:[],preserveRows:true,detail:'Color Map · no media'};const byHash=new Map(usable.map((item,index)=>[String(item.hash),index])),colors=await loadColors(usable,byHash);abort();const dino=await loadDino(usable,byHash);abort();post('progress',{done:0,total:usable.length,detail:'Composing perceptual color field…',stage:'layout'});const seam=hueSeam(colors),targetX=new Float32Array(usable.length),targetY=new Float32Array(usable.length);for(let i=0;i<usable.length;i++){const light=colors.available[i]?colors.l[i]:.5;targetY[i]=1-clamp(light);if(neutralAt(colors,i))targetX[i]=.5+(hashNoise(String(usable[i].hash))-.5)*.14;else targetX[i]=((colors.h[i]-seam+1)%1)}const cols=Math.max(24,Math.ceil(Math.sqrt(usable.length*1.55))),rows=Math.max(1,Math.ceil(usable.length/cols)),ordered=Array.from({length:usable.length},(_,i)=>i).sort((a,b)=>targetY[a]-targetY[b]||targetX[a]-targetX[b]||a-b),x=new Float32Array(usable.length),y=new Float32Array(usable.length);x.fill(-1);y.fill(-1);let above=null;for(let row=0;row<rows;row++){abort();const chunk=ordered.slice(row*cols,Math.min(usable.length,(row+1)*cols));const placed=orderColorRow(chunk,row,cols,targetX,targetY,colors,dino,above);for(let col=0;col<placed.length;col++){x[placed[col]]=col;y[placed[col]]=row}above=placed;if(row&&row%40===0)post('progress',{done:Math.min(usable.length,(row+1)*cols),total:usable.length,detail:`Composing perceptual color field · ${Math.min(usable.length,(row+1)*cols).toLocaleString()} placed…`,stage:'layout'})}const neutralCount=Array.from({length:usable.length},(_,i)=>i).reduce((sum,i)=>sum+(neutralAt(colors,i)?1:0),0);return{kind:'map',x,y,worldW:cols,worldH:rows,labels:[],preserveRows:true,detail:`Color Map · OKLab lightness × adaptive hue · ${neutralCount.toLocaleString()} neutrals centered · local visual AI refinement`}}

function validIndexes(result,media){
  const out=[];
  for(let i=0;i<media.length;i++){
    const x=Number(result?.x?.[i]),y=Number(result?.y?.[i]);
    if(Number.isFinite(x)&&Number.isFinite(y)&&x>=0&&y>=0)out.push(i);
  }
  return out;
}
function sourceRows(result,indexes){const grouped=new Map();for(const index of indexes){const key=Number(result.y[index]);let row=grouped.get(key);if(!row)grouped.set(key,row=[]);row.push(index)}return[...grouped.entries()].sort((a,b)=>a[0]-b[0]).map(([,row])=>row.sort((a,b)=>Number(result.x[a])-Number(result.x[b])||a-b))}
function makeRows(result,media,indexes,targetWidth){
  const ordered=indexes.slice().sort((a,b)=>(Number(result.y[a])-Number(result.y[b]))||(Number(result.x[a])-Number(result.x[b]))||a-b);
  const rows=[];
  let row=[],sum=0;
  const finish=()=>{if(!row.length)return;row.sort((a,b)=>(Number(result.x[a])-Number(result.x[b]))||(Number(result.y[a])-Number(result.y[b]))||a-b);rows.push(row);row=[];sum=0};
  for(const index of ordered){
    const r=layoutRatio(media[index]);
    if(row.length){const before=Math.abs(targetWidth-sum),after=Math.abs(targetWidth-(sum+r));if(sum>=targetWidth*.72&&after>before)finish()}
    row.push(index);sum+=r;
    if(sum>=targetWidth*1.08)finish();
  }
  finish();
  if(rows.length>1){const last=rows.at(-1),lastSum=last.reduce((s,i)=>s+layoutRatio(media[i]),0);if(lastSum<targetWidth*.36){const previous=rows[rows.length-2],merged=[...previous,...last].sort((a,b)=>(Number(result.y[a])-Number(result.y[b]))||(Number(result.x[a])-Number(result.x[b]))||a-b);let total=0;for(const i of merged)total+=layoutRatio(media[i]);let cut=1,running=0,best=Infinity;for(let i=0;i<merged.length-1;i++){running+=layoutRatio(media[merged[i]]);const error=Math.abs(running-total/2);if(error<best){best=error;cut=i+1}}rows.splice(rows.length-2,2,merged.slice(0,cut),merged.slice(cut))}}
  return rows;
}
function packRows(result,media,indexes){
  const totalRatio=indexes.reduce((sum,index)=>sum+layoutRatio(media[index]),0),suggestedWidth=Math.max(MIN_WORLD_WIDTH,Math.sqrt(Math.max(1,totalRatio))),rows=result?.preserveRows?sourceRows(result,indexes):makeRows(result,media,indexes,suggestedWidth),innerWidth=result?.preserveRows?Math.max(MIN_WORLD_WIDTH,...rows.map(row=>row.reduce((sum,index)=>sum+layoutRatio(media[index]),0)+GAP*Math.max(0,row.length-1))):suggestedWidth;
  const x=new Float32Array(media.length),y=new Float32Array(media.length),renderW=new Float32Array(media.length),renderH=new Float32Array(media.length);x.fill(-1);y.fill(-1);let top=.5;
  for(const row of rows){const sum=row.reduce((s,index)=>s+layoutRatio(media[index]),0),usable=Math.max(.1,innerWidth-GAP*Math.max(0,row.length-1)),height=Math.min(MAX_ROW_HEIGHT,usable/Math.max(.001,sum)),rowWidth=sum*height+GAP*Math.max(0,row.length-1);let left=.5+Math.max(0,(innerWidth-rowWidth)/2);for(const index of row){const boxW=layoutRatio(media[index])*height,boxH=height,[width,actualHeight]=fitAspect(media[index],boxW,boxH),centerX=left+boxW/2,centerY=top+boxH/2;x[index]=centerX-.5;y[index]=centerY-.5;renderW[index]=width;renderH[index]=actualHeight;left+=boxW+GAP}top+=height+GAP}
  return{...result,x,y,renderW,renderH,worldW:innerWidth+1,worldH:Math.max(1,top-GAP+.5),labels:[],detail:`${result.detail||'Experimental map'} · tight aspect packing`};
}
function densify(result,media){if(result?.kind!=='map'||!result.x?.length||!result.y?.length)return result;const indexes=validIndexes(result,media);return indexes.length?packRows(result,media,indexes):result}
function runLegacy(payload){return new Promise((resolve,reject)=>{const worker=new Worker(new URL('./experimental-layout-worker.js?v=20260912-8',self.location.href),{type:'module'});child=worker;let done=false;const finish=(fn,value)=>{if(done)return;done=true;if(child===worker)child=null;worker.terminate();fn(value)};worker.onerror=e=>finish(reject,new Error(e.message||'Experimental layout failed'));worker.onmessageerror=()=>finish(reject,new Error('Experimental layout returned unreadable data'));worker.onmessage=e=>{const data=e.data||{};if(data.type==='progress'){post('progress',data);return}if(data.type==='error')return finish(reject,new Error(data.error||'Experimental layout failed'));if(data.type==='result')finish(resolve,densify(data.result||{},payload.media||[]))};worker.postMessage({action:'build',payload})})}
async function run(payload){if(String(payload?.mode||'')==='color-map'){const media=Array.isArray(payload?.media)?payload.media:[];return densify(await beautifulColorMap(media),media)}return runLegacy(payload)}

self.onmessage=async event=>{
  const data=event.data||{};
  if(data.action==='cancel'){canceled=true;child?.terminate();child=null;return}
  if(data.action!=='build')return;
  canceled=false;
  try{const result=await run(data.payload||{});if(canceled)return;const transfer=[];for(const key of['order','x','y','renderW','renderH'])if(result[key]?.buffer)transfer.push(result[key].buffer);self.postMessage({type:'result',result},transfer)}catch(error){post('error',{error:error?.name==='AbortError'?'Canceled':String(error?.message||error),aborted:canceled||error?.name==='AbortError'})}
};
