let canceled=false;

const VIS_DB='mochimono-visual-similarity';
const VIS_VERSION=1;
const VIS_STORE='fingerprints';
const HASH_RE=/^[a-f0-9]{64}$/;
const COLOR_ASPECT=1.68;
const COLOR_OCCUPANCY=.90;
const NEUTRAL_OCCUPANCY=.92;
const NEUTRAL_GAP=2;
const HUE_ABSOLUTE_WEIGHT=.34;
const LIGHT_ABSOLUTE_WEIGHT=.82;
const AI_COLOR_VERSION='ai-sort-color-v1';
const FAMILY_WORKER_REV='20260912-color-family-1';

const post=(type,payload={})=>self.postMessage({type,...payload});
const abort=()=>{if(canceled)throw new DOMException('Aborted','AbortError')};
const clamp=(value,low=0,high=1)=>Math.max(low,Math.min(high,value));
const hashNoise=value=>{let hash=2166136261;for(let i=0;i<value.length;i++){hash^=value.charCodeAt(i);hash=Math.imul(hash,16777619)}return(hash>>>0)/4294967295};

function openDb(){return new Promise((resolve,reject)=>{const request=indexedDB.open(VIS_DB,VIS_VERSION);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)})}

function rowColor(row){
  const sorted=row?.aiSortColorVersion===AI_COLOR_VERSION?row.aiSortColor:null;
  if(sorted&&Number.isFinite(Number(sorted.l)))return{h:((Number(sorted.h)||0)%1+1)%1,l:clamp(Number(sorted.l)||0),c:Math.max(0,Number(sorted.c)||0),f:clamp(Number(sorted.f)||0)};
  const flow=row?.aiColorFlow;
  if(flow&&Number.isFinite(Number(flow.l)))return{h:((Number(flow.h)||0)%1+1)%1,l:clamp(Number(flow.l)||0),c:Math.max(0,Number(flow.c)||0),f:clamp(Number(flow.f)||0)};
  const color=row?.visualColor,feature=row?.visualFeature;
  if(!color&&!feature)return null;
  return{h:((Number(color?.dominantHue)||0)%1+1)%1,l:clamp((Number(feature?.meanLuma)||127)/255),c:Math.max(0,Number(color?.meanChroma)||0),f:clamp(Number(color?.colorFraction)||0)};
}

async function loadColors(media){
  const byHash=new Map(media.map((item,index)=>[String(item.hash),index])),colors=Array(media.length).fill(null);
  let db;
  try{
    db=await openDb();
    if(!db.objectStoreNames.contains(VIS_STORE))return colors;
    post('progress',{done:0,total:media.length,detail:'Reading perceptual color…',stage:'visual'});
    const store=db.transaction(VIS_STORE,'readonly').objectStore(VIS_STORE);
    const rows=await new Promise((resolve,reject)=>{const request=store.getAll();request.onsuccess=()=>resolve(request.result||[]);request.onerror=()=>reject(request.error)});
    abort();let found=0;
    for(let scanned=0;scanned<rows.length;scanned++){
      if((scanned&2047)===0)abort();
      const row=rows[scanned]||{},index=byHash.get(String(row.hash||''));
      if(index!=null){const color=rowColor(row);if(color){colors[index]=color;found++}}
      if(scanned&&scanned%10000===0)post('progress',{done:found,total:media.length,detail:`Reading perceptual color · ${found.toLocaleString()} matched…`,stage:'visual'});
    }
    return colors;
  }catch(error){if(error?.name==='AbortError')throw error;return colors}
  finally{db?.close?.()}
}

function neutral(color){return!color||color.c<.032||color.f<.15}

function hueSeam(colors){
  const bins=64,hist=new Float64Array(bins);let total=0;
  for(const color of colors){if(neutral(color))continue;const weight=(.15+Math.min(1,color.c*7))*(.3+.7*color.f);hist[Math.min(bins-1,Math.floor(color.h*bins))]+=weight;total+=weight}
  if(total<=0)return 0;
  let best=0,bestScore=Infinity;
  for(let bin=0;bin<bins;bin++){
    const score=hist[(bin+bins-2)%bins]*.25+hist[(bin+bins-1)%bins]*.7+hist[bin]*1.25+hist[(bin+1)%bins]*.7+hist[(bin+2)%bins]*.25;
    if(score<bestScore){bestScore=score;best=bin}
  }
  return(best+.5)/bins;
}

function rankMap(indexes,valueFor){
  const sorted=indexes.slice().sort((a,b)=>valueFor(a)-valueFor(b)||a-b),out=new Float32Array(Math.max(1,...indexes.map(i=>i+1)));
  const denominator=Math.max(1,sorted.length-1);
  for(let rank=0;rank<sorted.length;rank++)out[sorted[rank]]=rank/denominator;
  return out;
}

function axisTargets(colors,indexes,seam){
  const hueValue=index=>((colors[index].h-seam+1)%1);
  const hueRank=rankMap(indexes,hueValue),lightRank=rankMap(indexes,index=>colors[index].l);
  const tx=new Float32Array(colors.length),ty=new Float32Array(colors.length);
  for(const index of indexes){
    const hue=hueValue(index),light=colors[index].l;
    tx[index]=HUE_ABSOLUTE_WEIGHT*hue+(1-HUE_ABSOLUTE_WEIGHT)*hueRank[index];
    ty[index]=LIGHT_ABSOLUTE_WEIGHT*(1-light)+(1-LIGHT_ABSOLUTE_WEIGHT)*(1-lightRank[index]);
  }
  return{tx,ty};
}

function nearestFree(used,cols,rows,targetX,targetY){
  const cx=Math.max(0,Math.min(cols-1,Math.round(targetX))),cy=Math.max(0,Math.min(rows-1,Math.round(targetY))),direct=cy*cols+cx;
  if(!used[direct])return[cx,cy];
  const maxRadius=Math.max(cols,rows);let bestX=cx,bestY=cy,bestScore=Infinity;
  for(let radius=1;radius<=maxRadius;radius++){
    let found=false;const left=Math.max(0,cx-radius),right=Math.min(cols-1,cx+radius),top=Math.max(0,cy-radius),bottom=Math.min(rows-1,cy+radius);
    const consider=(x,y)=>{const slot=y*cols+x;if(used[slot])return;const dx=x-targetX,dy=y-targetY,score=dx*dx+dy*dy*1.2;if(score<bestScore){bestScore=score;bestX=x;bestY=y;found=true}};
    for(let x=left;x<=right;x++){consider(x,top);if(bottom!==top)consider(x,bottom)}
    for(let y=top+1;y<bottom;y++){consider(left,y);if(right!==left)consider(right,y)}
    if(found)return[bestX,bestY];
  }
  return[cx,cy];
}

async function loadFamilies(media){
  if(typeof Worker!=='function')return null;
  return new Promise(resolve=>{
    let settled=false;
    const finish=value=>{if(settled)return;settled=true;try{familyWorker.terminate()}catch{}resolve(value)};
    const familyWorker=new Worker(new URL(`./ai-global-multimodal-worker.js?v=${FAMILY_WORKER_REV}`,import.meta.url),{type:'module'});
    familyWorker.onerror=()=>finish(null);
    familyWorker.onmessage=event=>{
      const data=event.data||{};
      if(data.type==='progress'){post('progress',{...data,detail:`AI families · ${data.detail||'matching related media…'}`});return}
      if(data.type==='result')finish(data.result||null);
      else if(data.type==='error')finish(null);
    };
    familyWorker.postMessage({action:'sort',payload:{media}});
  });
}

function familyInfo(indexes,familyIds,order,media){
  const orderRank=new Int32Array(media.length);orderRank.fill(1e9);
  if(Array.isArray(order)){const byHash=new Map(media.map((item,index)=>[item.hash,index]));for(let rank=0;rank<order.length;rank++){const index=byHash.get(String(order[rank]));if(index!=null)orderRank[index]=rank}}
  const groups=new Map(),singles=[];
  for(const index of indexes){const id=Number(familyIds?.[index]);if(Number.isInteger(id)&&id>=0){let members=groups.get(id);if(!members)groups.set(id,members=[]);members.push(index)}else singles.push(index)}
  const multi=[];
  for(const members of groups.values()){
    members.sort((a,b)=>orderRank[a]-orderRank[b]||a-b);
    if(members.length>1)multi.push(members);else singles.push(members[0]);
  }
  multi.sort((a,b)=>b.length-a.length||orderRank[a[0]]-orderRank[b[0]]);
  singles.sort((a,b)=>orderRank[a]-orderRank[b]||a-b);
  return{multi,singles,orderRank};
}

function familyStrength(members,tx,ty){
  let mx=0,my=0;for(const index of members){mx+=tx[index];my+=ty[index]}mx/=members.length;my/=members.length;
  let spreadX=0,spreadY=0;for(const index of members){spreadX+=Math.abs(tx[index]-mx);spreadY+=Math.abs(ty[index]-my)}spreadX/=members.length;spreadY/=members.length;
  const xStrength=spreadX<.055?.86:spreadX<.11?.72:spreadX<.18?.50:spreadX<.28?.28:.10;
  const yStrength=spreadY<.08?.54:spreadY<.18?.38:.20;
  return{mx,my,xStrength,yStrength};
}

function placeColorField(media,colors,indexes,seam,families,x,y){
  if(!indexes.length)return{cols:0,rows:0,familyGroups:0};
  const slots=Math.max(indexes.length,Math.ceil(indexes.length/COLOR_OCCUPANCY)),cols=Math.max(16,Math.ceil(Math.sqrt(slots*COLOR_ASPECT))),rows=Math.max(1,Math.ceil(slots/cols)),used=new Uint8Array(cols*rows);
  const{tx,ty}=axisTargets(colors,indexes,seam),{multi,singles}=familyInfo(indexes,families?.familyIds,families?.order,media);
  let placed=0;
  const put=(index,nx,ny)=>{const[px,py]=nearestFree(used,cols,rows,nx*Math.max(0,cols-1),ny*Math.max(0,rows-1));used[py*cols+px]=1;x[index]=px;y[index]=py;if(++placed%5000===0)post('progress',{done:placed,total:media.length,detail:`Placing color field · ${placed.toLocaleString()}…`,stage:'layout'})};
  for(const members of multi){
    abort();const family=familyStrength(members,tx,ty);
    for(let position=0;position<members.length;position++){
      const index=members[position],ring=position?Math.sqrt(position)*.0035:0,angle=position*2.399963229728653;
      const nx=family.mx+(tx[index]-family.mx)*(1-family.xStrength)+Math.cos(angle)*ring;
      const ny=family.my+(ty[index]-family.my)*(1-family.yStrength)+Math.sin(angle)*ring*.7;
      put(index,clamp(nx),clamp(ny));
    }
  }
  singles.sort((a,b)=>{const ca=colors[a],cb=colors[b],va=ca.c*5+ca.f,vb=cb.c*5+cb.f;return vb-va||Math.abs(ca.l-.5)-Math.abs(cb.l-.5)||String(media[a].hash).localeCompare(String(media[b].hash))});
  for(const index of singles){abort();put(index,tx[index],ty[index])}
  return{cols,rows,familyGroups:multi.length};
}

function placeNeutrals(media,colors,indexes,startX,families,x,y){
  if(!indexes.length)return{cols:0,rows:0,familyGroups:0};
  const slots=Math.max(indexes.length,Math.ceil(indexes.length/NEUTRAL_OCCUPANCY)),cols=Math.max(4,Math.ceil(Math.sqrt(slots))),rows=Math.max(1,Math.ceil(slots/cols)),used=new Uint8Array(cols*rows),lightRank=rankMap(indexes,index=>colors[index]?.l??.5),{multi,singles}=familyInfo(indexes,families?.familyIds,families?.order,media);
  const targetY=index=>LIGHT_ABSOLUTE_WEIGHT*(1-(colors[index]?.l??.5))+(1-LIGHT_ABSOLUTE_WEIGHT)*(1-lightRank[index]);
  const placeGroup=(members,seed)=>{
    let meanY=0;for(const index of members)meanY+=targetY(index);meanY/=members.length;
    const baseX=.08+.84*hashNoise(String(seed));
    for(let position=0;position<members.length;position++){
      const index=members[position],angle=position*2.399963229728653,ring=Math.sqrt(position)*.008;
      const nx=clamp(baseX+Math.cos(angle)*ring),ny=clamp(meanY*.55+targetY(index)*.45+Math.sin(angle)*ring*.6),[px,py]=nearestFree(used,cols,rows,nx*Math.max(0,cols-1),ny*Math.max(0,rows-1));
      used[py*cols+px]=1;x[index]=startX+px;y[index]=py;
    }
  };
  for(const members of multi){abort();placeGroup(members,media[members[0]]?.hash||members[0])}
  for(const index of singles){abort();const nx=hashNoise(String(media[index]?.hash||index)),ny=targetY(index),[px,py]=nearestFree(used,cols,rows,nx*Math.max(0,cols-1),ny*Math.max(0,rows-1));used[py*cols+px]=1;x[index]=startX+px;y[index]=py}
  return{cols,rows,familyGroups:multi.length};
}

async function build(media){
  const usable=Array.isArray(media)?media.filter(item=>HASH_RE.test(String(item?.hash||''))):[];
  if(!usable.length)return{kind:'map',x:new Float32Array(),y:new Float32Array(),worldW:1,worldH:1,labels:[],detail:'Color Map · no media'};
  const[colorResult,families]=await Promise.all([loadColors(usable),loadFamilies(usable).catch(()=>null)]),colors=colorResult;
  abort();
  const colorful=[],neutrals=[];for(let index=0;index<usable.length;index++)(neutral(colors[index])?neutrals:colorful).push(index);
  const seam=hueSeam(colors),x=new Float32Array(usable.length),y=new Float32Array(usable.length);x.fill(-1);y.fill(-1);
  post('progress',{done:0,total:usable.length,detail:'Building balanced hue × lightness field with AI families…',stage:'layout'});
  const field=placeColorField(usable,colors,colorful,seam,families,x,y),neutralStart=field.cols?field.cols+NEUTRAL_GAP:0,neutralField=placeNeutrals(usable,colors,neutrals,neutralStart,families,x,y),worldH=Math.max(1,field.rows,neutralField.rows),worldW=Math.max(1,field.cols+(neutrals.length?NEUTRAL_GAP+neutralField.cols:0));
  return{kind:'map',x,y,worldW,worldH,labels:[],preserveRows:false,detail:`Color Map · adaptive hue × lightness · ${field.familyGroups.toLocaleString()} colorful AI families · ${neutrals.length.toLocaleString()} neutral / low-color`};
}

self.onmessage=async event=>{
  const data=event.data||{};
  if(data.action==='cancel'){canceled=true;return}
  if(data.action!=='build')return;
  canceled=false;
  try{const media=Array.isArray(data.payload?.media)?data.payload.media:[],result=await build(media);if(!canceled)post('result',{result})}
  catch(error){post('error',{error:error?.message||String(error),aborted:error?.name==='AbortError'})}
};
