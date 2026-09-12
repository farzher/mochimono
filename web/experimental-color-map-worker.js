let canceled=false;

const VIS_DB='mochimono-visual-similarity';
const VIS_VERSION=1;
const VIS_STORE='fingerprints';
const HASH_RE=/^[a-f0-9]{64}$/;
const COLOR_ASPECT=1.55;
const COLOR_OCCUPANCY=.74;
const NEUTRAL_GAP=2;

const post=(type,payload={})=>self.postMessage({type,...payload});
const abort=()=>{if(canceled)throw new DOMException('Aborted','AbortError')};
const clamp=(value,low=0,high=1)=>Math.max(low,Math.min(high,value));
const hashNoise=value=>{let hash=2166136261;for(let i=0;i<value.length;i++){hash^=value.charCodeAt(i);hash=Math.imul(hash,16777619)}return(hash>>>0)/4294967295};

function openDb(){
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open(VIS_DB,VIS_VERSION);
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
}

function rowColor(row){
  const flow=row?.aiColorFlow;
  if(flow&&Number.isFinite(Number(flow.l))){
    return{
      h:((Number(flow.h)||0)%1+1)%1,
      l:clamp(Number(flow.l)||0),
      c:Math.max(0,Number(flow.c)||0),
      f:clamp(Number(flow.f)||0)
    };
  }
  const color=row?.visualColor,feature=row?.visualFeature;
  if(!color&&!feature)return null;
  return{
    h:((Number(color?.dominantHue)||0)%1+1)%1,
    l:clamp((Number(feature?.meanLuma)||127)/255),
    c:Math.max(0,Number(color?.meanChroma)||0),
    f:clamp(Number(color?.colorFraction)||0)
  };
}

async function loadColors(media){
  const byHash=new Map(media.map((item,index)=>[String(item.hash),index]));
  const colors=Array(media.length).fill(null);
  let db;
  try{
    db=await openDb();
    if(!db.objectStoreNames.contains(VIS_STORE))return colors;
    post('progress',{done:0,total:media.length,detail:'Reading perceptual color…',stage:'visual'});
    const store=db.transaction(VIS_STORE,'readonly').objectStore(VIS_STORE);
    const rows=await new Promise((resolve,reject)=>{
      const request=store.getAll();
      request.onsuccess=()=>resolve(request.result||[]);
      request.onerror=()=>reject(request.error);
    });
    abort();
    let found=0;
    for(let scanned=0;scanned<rows.length;scanned++){
      if((scanned&2047)===0)abort();
      const row=rows[scanned]||{},index=byHash.get(String(row.hash||''));
      if(index!=null){
        const color=rowColor(row);
        if(color){colors[index]=color;found++}
      }
      if(scanned&&scanned%10000===0)post('progress',{done:found,total:media.length,detail:`Reading perceptual color · ${found.toLocaleString()} matched…`,stage:'visual'});
    }
    return colors;
  }catch(error){if(error?.name==='AbortError')throw error;return colors}
  finally{db?.close?.()}
}

function neutral(color){return!color||color.c<.028||color.f<.13}

function hueSeam(colors){
  const bins=48,hist=new Float64Array(bins);
  let total=0;
  for(const color of colors){
    if(neutral(color))continue;
    const weight=(.12+Math.min(1,color.c*7))*(.25+.75*color.f);
    hist[Math.min(bins-1,Math.floor(color.h*bins))]+=weight;
    total+=weight;
  }
  if(total<=0)return 0;
  let best=0,bestScore=Infinity;
  for(let bin=0;bin<bins;bin++){
    const score=hist[(bin+bins-2)%bins]*.3+hist[(bin+bins-1)%bins]*.75+hist[bin]*1.2+hist[(bin+1)%bins]*.75+hist[(bin+2)%bins]*.3;
    if(score<bestScore){bestScore=score;best=bin}
  }
  return(best+.5)/bins;
}

function nearestFree(used,cols,rows,targetX,targetY){
  const cx=Math.max(0,Math.min(cols-1,Math.round(targetX)));
  const cy=Math.max(0,Math.min(rows-1,Math.round(targetY)));
  const direct=cy*cols+cx;
  if(!used[direct])return[cx,cy];

  const maxRadius=Math.max(cols,rows);
  let bestX=cx,bestY=cy,bestScore=Infinity;
  for(let radius=1;radius<=maxRadius;radius++){
    let found=false;
    const left=Math.max(0,cx-radius),right=Math.min(cols-1,cx+radius);
    const top=Math.max(0,cy-radius),bottom=Math.min(rows-1,cy+radius);
    const consider=(x,y)=>{
      const slot=y*cols+x;
      if(used[slot])return;
      const dx=x-targetX,dy=y-targetY;
      const score=dx*dx+dy*dy*1.35;
      if(score<bestScore){bestScore=score;bestX=x;bestY=y;found=true}
    };
    for(let x=left;x<=right;x++){consider(x,top);if(bottom!==top)consider(x,bottom)}
    for(let y=top+1;y<bottom;y++){consider(left,y);if(right!==left)consider(right,y)}
    if(found)return[bestX,bestY];
  }
  return[cx,cy];
}

function placeColorField(media,colors,colorIndexes,seam,x,y){
  if(!colorIndexes.length)return{cols:0,rows:0};
  const slots=Math.max(colorIndexes.length,Math.ceil(colorIndexes.length/COLOR_OCCUPANCY));
  const cols=Math.max(16,Math.ceil(Math.sqrt(slots*COLOR_ASPECT)));
  const rows=Math.max(1,Math.ceil(slots/cols));
  const used=new Uint8Array(cols*rows);

  const ordered=colorIndexes.slice().sort((a,b)=>{
    const ca=colors[a],cb=colors[b];
    const vividA=ca.c*5+ca.f,vividB=cb.c*5+cb.f;
    return vividB-vividA||Math.abs(ca.l-.5)-Math.abs(cb.l-.5)||String(media[a].hash).localeCompare(String(media[b].hash));
  });

  for(let placed=0;placed<ordered.length;placed++){
    abort();
    const index=ordered[placed],color=colors[index];
    const hue=(color.h-seam+1)%1;
    const targetX=hue*Math.max(0,cols-1);
    const targetY=(1-color.l)*Math.max(0,rows-1);
    const [px,py]=nearestFree(used,cols,rows,targetX,targetY);
    used[py*cols+px]=1;
    x[index]=px;
    y[index]=py;
    if(placed&&placed%5000===0)post('progress',{done:placed,total:media.length,detail:`Placing color field · ${placed.toLocaleString()}…`,stage:'layout'});
  }
  return{cols,rows};
}

function placeNeutrals(media,colors,indexes,startX,x,y){
  if(!indexes.length)return{cols:0,rows:0};
  const cols=Math.max(4,Math.ceil(Math.sqrt(indexes.length)));
  const rows=Math.max(1,Math.ceil(indexes.length/cols));
  const ordered=indexes.slice().sort((a,b)=>{
    const ca=colors[a],cb=colors[b];
    const la=ca?.l??.5,lb=cb?.l??.5;
    const availableA=ca?0:1,availableB=cb?0:1;
    return lb-la||availableA-availableB||hashNoise(String(media[a].hash))-hashNoise(String(media[b].hash));
  });
  for(let position=0;position<ordered.length;position++){
    const index=ordered[position];
    const row=Math.floor(position/cols);
    const col=position%cols;
    x[index]=startX+col;
    y[index]=row;
  }
  return{cols,rows};
}

async function build(media){
  const usable=Array.isArray(media)?media.filter(item=>HASH_RE.test(String(item?.hash||''))):[];
  if(!usable.length)return{kind:'map',x:new Float32Array(),y:new Float32Array(),worldW:1,worldH:1,labels:[],detail:'Color Map · no media'};

  const colors=await loadColors(usable);
  abort();
  const colorful=[],neutrals=[];
  for(let index=0;index<usable.length;index++)(neutral(colors[index])?neutrals:colorful).push(index);
  const seam=hueSeam(colors);
  const x=new Float32Array(usable.length),y=new Float32Array(usable.length);
  x.fill(-1);y.fill(-1);
  post('progress',{done:0,total:usable.length,detail:'Building true hue × lightness field…',stage:'layout'});

  const field=placeColorField(usable,colors,colorful,seam,x,y);
  const neutralStart=field.cols?field.cols+NEUTRAL_GAP:0;
  const neutralField=placeNeutrals(usable,colors,neutrals,neutralStart,x,y);
  const worldH=Math.max(1,field.rows,neutralField.rows);
  const worldW=Math.max(1,field.cols+(neutrals.length?NEUTRAL_GAP+neutralField.cols:0));
  return{
    kind:'map',x,y,worldW,worldH,labels:[],preserveRows:false,
    detail:`Color Map · true hue × lightness · ${neutrals.length.toLocaleString()} neutral / low-color images separated`
  };
}

self.onmessage=async event=>{
  const data=event.data||{};
  if(data.action==='cancel'){canceled=true;return}
  if(data.action!=='build')return;
  canceled=false;
  try{
    const media=Array.isArray(data.payload?.media)?data.payload.media:[];
    const result=await build(media);
    if(!canceled)post('result',{result});
  }catch(error){
    post('error',{error:error?.message||String(error),aborted:error?.name==='AbortError'});
  }
};
