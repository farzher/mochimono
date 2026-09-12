let canceled=false;

const VIS_DB='mochimono-visual-similarity';
const VIS_VERSION=1;
const VIS_STORE='fingerprints';
const HASH_RE=/^[a-f0-9]{64}$/;
const ROBUST_VERSION='phash32-dct16-v1';
const TEMPLATE_VERSION='template12-v1';
const TEMPLATE_DIM=216;
const FEATURE_VERSION='layout-edge-palette-v3';

const COLOR_ASPECT=1.68;
const COLOR_OCCUPANCY=.92;
const NEUTRAL_OCCUPANCY=.94;
const NEUTRAL_GAP=2;
const HUE_ABSOLUTE_WEIGHT=.28;
const LIGHT_ABSOLUTE_WEIGHT=.82;
const AI_COLOR_VERSION='ai-sort-color-v1';
const FAMILY_WORKER_REV='20260912-color-family-2';

const PACK_GAP=.004;
const PACK_SECTION_GAP=.05;
const PACK_MIN_RATIO=.5;
const PACK_MAX_RATIO=2;
const PACK_MAX_ROW_HEIGHT=1.08;
const PACK_MIN_ROW_HEIGHT=.32;
const EXTREME_RATIO=4;
const ATOMIC_CHUNK=24;

const DUP_BANDS=16;
const DUP_STRONG_PHASH=7;
const DUP_MAX_PHASH=15;
const DUP_STRONG_TEMPLATE=.082;
const DUP_MAX_TEMPLATE=.052;

const SERIES_PROJECTIONS=4;
const SERIES_WINDOW=9;
const SERIES_STRONG=.082;
const SERIES_MAX=.125;
const SERIES_TEMPLATE_MAX=.155;
const SERIES_ASPECT_MAX=.22;
const SERIES_HUE_MAX=.11;
const SERIES_LIGHT_MAX=.11;
const SERIES_PHASH_MAX=88;
const SERIES_VECTOR_DIM=39;

const POPCOUNT16=new Uint8Array(1<<16);
for(let value=1;value<POPCOUNT16.length;value++)POPCOUNT16[value]=POPCOUNT16[value>>1]+(value&1);

const post=(type,payload={})=>self.postMessage({type,...payload});
const abort=()=>{if(canceled)throw new DOMException('Aborted','AbortError')};
const clamp=(value,low=0,high=1)=>Math.max(low,Math.min(high,value));
const hashNoise=value=>{let hash=2166136261;for(let i=0;i<value.length;i++){hash^=value.charCodeAt(i);hash=Math.imul(hash,16777619)}return(hash>>>0)/4294967295};
const hueDelta=(a,b)=>Math.min(Math.abs(a-b),1-Math.abs(a-b));

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
function validFeature(feature){return feature?.version===FEATURE_VERSION&&feature.layout?.length===48&&feature.edges?.length===64&&feature.energy?.length===16&&feature.hues?.length===24}
async function loadVisual(media){
  const byHash=new Map(media.map((item,index)=>[String(item.hash),index]));
  const colors=Array(media.length).fill(null),robust=Array(media.length).fill(''),templates=Array(media.length).fill(null),features=Array(media.length).fill(null);
  let db;
  try{
    db=await openDb();
    if(!db.objectStoreNames.contains(VIS_STORE))return{colors,robust,templates,features};
    post('progress',{done:0,total:media.length,detail:'Reading color, structure, and duplicate fingerprints…',stage:'visual'});
    const rows=await new Promise((resolve,reject)=>{const request=db.transaction(VIS_STORE,'readonly').objectStore(VIS_STORE).getAll();request.onsuccess=()=>resolve(request.result||[]);request.onerror=()=>reject(request.error)});
    abort();let found=0;
    for(let scanned=0;scanned<rows.length;scanned++){
      if((scanned&2047)===0)abort();
      const row=rows[scanned]||{},index=byHash.get(String(row.hash||''));
      if(index==null)continue;
      const color=rowColor(row);if(color)colors[index]=color;
      if(row.robustVersion===ROBUST_VERSION&&HASH_RE.test(String(row.robust||'')))robust[index]=String(row.robust);
      if(row.experimentalTemplateVersion===TEMPLATE_VERSION&&row.experimentalTemplate?.length===TEMPLATE_DIM)templates[index]=row.experimentalTemplate;
      if(row.visualFeatureVersion===FEATURE_VERSION&&validFeature(row.visualFeature))features[index]=row.visualFeature;
      found++;
      if(scanned&&scanned%10000===0)post('progress',{done:found,total:media.length,detail:`Reading visual descriptors · ${found.toLocaleString()} matched…`,stage:'visual'});
    }
    return{colors,robust,templates,features};
  }catch(error){if(error?.name==='AbortError')throw error;return{colors,robust,templates,features}}
  finally{db?.close?.()}
}

function hammingHex(left,right){
  if(!HASH_RE.test(left)||!HASH_RE.test(right))return 256;
  let total=0;for(let i=0;i<16;i++)total+=POPCOUNT16[parseInt(left.slice(i*4,i*4+4),16)^parseInt(right.slice(i*4,i*4+4),16)];
  return total;
}
function templateDistance(a,b){
  if(!a?.length||!b?.length||a.length!==TEMPLATE_DIM||b.length!==TEMPLATE_DIM)return null;
  let meanA=0,meanB=0;for(let i=0;i<144;i++){meanA+=a[i];meanB+=b[i]}meanA/=144;meanB/=144;
  let luma=0,chroma=0;for(let i=0;i<144;i++){const d=((a[i]-meanA)-(b[i]-meanB))/255;luma+=d*d}for(let i=144;i<TEMPLATE_DIM;i++){const d=(a[i]-b[i])/255;chroma+=d*d}
  return Math.sqrt(luma/144)*.65+Math.sqrt(chroma/(TEMPLATE_DIM-144))*.25+Math.abs(meanA-meanB)/255*.10;
}
function colorClose(a,b,light=.065,hue=.055){return Boolean(a&&b)&&Math.abs(a.l-b.l)<=light&&(hueDelta(a.h,b.h)<=hue||a.c<.025||b.c<.025)}
function nearDuplicate(a,b,robust,templates,colors){
  const distance=hammingHex(robust[a],robust[b]);if(distance>DUP_MAX_PHASH)return false;
  const template=templateDistance(templates[a],templates[b]);
  if(template!=null)return distance<=DUP_STRONG_PHASH?template<=DUP_STRONG_TEMPLATE:template<=DUP_MAX_TEMPLATE;
  return distance<=4&&colorClose(colors[a],colors[b]);
}
function makeUnion(n){
  const parent=new Int32Array(n),size=new Int32Array(n);for(let i=0;i<n;i++){parent[i]=i;size[i]=1}
  const find=i=>{let root=i;while(parent[root]!==root)root=parent[root];while(parent[i]!==i){const next=parent[i];parent[i]=root;i=next}return root};
  const union=(a,b)=>{a=find(a);b=find(b);if(a===b)return a;if(size[a]<size[b])[a,b]=[b,a];parent[b]=a;size[a]+=size[b];return a};
  return{parent,size,find,union};
}
function addDuplicateEdges(union,robust,templates,colors){
  const n=robust.length,stamp=new Int32Array(n),heads=new Int32Array(DUP_BANDS*(1<<16)),next=new Int32Array(DUP_BANDS*n);heads.fill(-1);next.fill(-1);
  const exactReps=new Map();let generation=1,comparisons=0;
  for(let index=0;index<n;index++){
    abort();const hash=robust[index];if(!HASH_RE.test(hash))continue;
    let matchedExact=false,reps=exactReps.get(hash);
    if(reps){for(const candidate of reps){if(nearDuplicate(index,candidate,robust,templates,colors)){union.union(index,candidate);matchedExact=true;break}}}
    if(!matchedExact){if(reps)reps.push(index);else exactReps.set(hash,reps=[index])}
    if(++generation===2147483647){stamp.fill(0);generation=1}
    for(let band=0;band<DUP_BANDS;band++){
      const key=parseInt(hash.slice(band*4,band*4+4),16),headOffset=band*(1<<16)+key;
      for(let candidate=heads[headOffset];candidate>=0;candidate=next[band*n+candidate]){
        if(stamp[candidate]===generation)continue;stamp[candidate]=generation;if(robust[candidate]===hash)continue;
        if(nearDuplicate(index,candidate,robust,templates,colors))union.union(index,candidate);
        if(++comparisons%250000===0)abort();
      }
    }
    for(let band=0;band<DUP_BANDS;band++){const key=parseInt(hash.slice(band*4,band*4+4),16),headOffset=band*(1<<16)+key,nextOffset=band*n+index;next[nextOffset]=heads[headOffset];heads[headOffset]=index}
  }
}

function mediaRatio(item){const width=Math.max(1,Number(item?.width)||1),height=Math.max(1,Number(item?.height)||1);return width/height}
function aspectDistance(a,b){return Math.abs(Math.log2(Math.max(1e-6,a)/Math.max(1e-6,b)))}
function seriesVector(feature,target,offset){
  let mean=0;for(let cell=0;cell<16;cell++)mean+=(Number(feature.layout[cell*3])||0)/255;mean/=16;
  let cursor=offset;for(let cell=0;cell<16;cell++)target[cursor++]=((Number(feature.layout[cell*3])||0)/255-mean);
  for(let cell=0;cell<16;cell++)target[cursor++]=(Number(feature.energy[cell])||0)/255;
  for(let orientation=0;orientation<4;orientation++){let sum=0;for(let cell=0;cell<16;cell++)sum+=(Number(feature.edges[cell*4+orientation])||0)/255;target[cursor++]=sum/16}
  target[cursor++]=(Number(feature.contrast)||0)/255;target[cursor++]=(Number(feature.edgeDensity)||0)/255;target[cursor++]=(Number(feature.colorfulness)||0)/255;
}
function seriesProjectionWeights(seed){const out=new Float32Array(SERIES_VECTOR_DIM);let state=Math.imul(seed+1,0x9e3779b1)>>>0;for(let i=0;i<out.length;i++){state^=state<<13;state^=state>>>17;state^=state<<5;out[i]=(state&1)?1:-1}return out}
function seriesDistance(vectors,a,b){
  const ao=a*SERIES_VECTOR_DIM,bo=b*SERIES_VECTOR_DIM;let luma=0,energy=0,edges=0;
  for(let i=0;i<16;i++)luma+=Math.abs(vectors[ao+i]-vectors[bo+i]);for(let i=16;i<32;i++)energy+=Math.abs(vectors[ao+i]-vectors[bo+i]);for(let i=32;i<36;i++)edges+=Math.abs(vectors[ao+i]-vectors[bo+i]);
  const stats=(Math.abs(vectors[ao+36]-vectors[bo+36])+Math.abs(vectors[ao+37]-vectors[bo+37])+Math.abs(vectors[ao+38]-vectors[bo+38]))/3;
  return(luma/16)*.42+(energy/16)*.30+(edges/4)*.18+stats*.10;
}
function seriesSimilar(a,b,media,features,vectors,colors,templates,robust){
  if(!features[a]||!features[b])return false;
  const aspect=aspectDistance(mediaRatio(media[a]),mediaRatio(media[b]));if(aspect>SERIES_ASPECT_MAX)return false;
  const ca=colors[a],cb=colors[b];if(ca&&cb){if(Math.abs(ca.l-cb.l)>SERIES_LIGHT_MAX)return false;if(ca.c>.025&&cb.c>.025&&hueDelta(ca.h,cb.h)>SERIES_HUE_MAX)return false}
  const structure=seriesDistance(vectors,a,b);if(structure<=SERIES_STRONG&&aspect<=.16)return true;if(structure>SERIES_MAX)return false;
  const template=templateDistance(templates[a],templates[b]);if(template!=null&&template<=SERIES_TEMPLATE_MAX)return true;
  return hammingHex(robust[a],robust[b])<=SERIES_PHASH_MAX&&structure<=.105;
}
function addSeriesEdges(union,media,features,templates,robust,colors){
  const n=media.length,vectors=new Float32Array(n*SERIES_VECTOR_DIM),active=[];for(let i=0;i<n;i++)if(features[i]){seriesVector(features[i],vectors,i*SERIES_VECTOR_DIM);active.push(i)}
  if(active.length<2)return{joined:0};
  post('progress',{done:0,total:active.length,detail:'Finding repeated visual layouts…',stage:'series'});
  const projections=[];
  for(let p=0;p<SERIES_PROJECTIONS;p++){
    abort();const weights=seriesProjectionWeights(p),values=new Float32Array(n);
    for(const i of active){let sum=0,o=i*SERIES_VECTOR_DIM;for(let d=0;d<SERIES_VECTOR_DIM;d++)sum+=vectors[o+d]*weights[d];values[i]=sum}
    const order=active.slice().sort((a,b)=>values[a]-values[b]||a-b),positions=new Int32Array(n);positions.fill(-1);for(let rank=0;rank<order.length;rank++)positions[order[rank]]=rank;projections.push({order,positions});
  }
  const stamp=new Int32Array(n);let generation=1,checked=0,joined=0;
  for(let ai=0;ai<active.length;ai++){
    const i=active[ai];if(++generation===2147483647){stamp.fill(0);generation=1}
    for(const projection of projections){
      const pos=projection.positions[i],start=Math.max(0,pos-SERIES_WINDOW),end=Math.min(projection.order.length,pos+SERIES_WINDOW+1);
      for(let cursor=start;cursor<end;cursor++){
        const j=projection.order[cursor];if(j===i||j>i||stamp[j]===generation)continue;stamp[j]=generation;
        if(seriesSimilar(i,j,media,features,vectors,colors,templates,robust)){union.union(i,j);joined++}
        if(++checked%250000===0)abort();
      }
    }
    if(ai&&ai%5000===0)post('progress',{done:ai,total:active.length,detail:`Repeated layouts · ${ai.toLocaleString()} / ${active.length.toLocaleString()} scanned…`,stage:'series'});
  }
  return{joined};
}
function hardGroups(media,visual){
  const union=makeUnion(media.length);addDuplicateEdges(union,visual.robust,visual.templates,visual.colors);const series=addSeriesEdges(union,media,visual.features,visual.templates,visual.robust,visual.colors);
  const grouped=new Map();for(let i=0;i<media.length;i++){const root=union.find(i);if(union.size[root]<2)continue;let members=grouped.get(root);if(!members)grouped.set(root,members=[]);members.push(i)}
  const ids=new Int32Array(media.length);ids.fill(-1);let id=0,locked=0;const groups=[...grouped.values()].sort((a,b)=>b.length-a.length||a[0]-b[0]);for(const members of groups){for(const index of members)ids[index]=id;locked+=members.length;id++}
  return{ids,groups,count:id,locked,seriesEdges:series.joined||0};
}

function neutral(color){return!color||color.c<.032||color.f<.15}
function hueSeam(colors){
  const bins=64,hist=new Float64Array(bins);let total=0;for(const color of colors){if(neutral(color))continue;const weight=(.15+Math.min(1,color.c*7))*(.3+.7*color.f);hist[Math.min(bins-1,Math.floor(color.h*bins))]+=weight;total+=weight}if(total<=0)return 0;
  let best=0,bestScore=Infinity;for(let bin=0;bin<bins;bin++){const score=hist[(bin+bins-2)%bins]*.25+hist[(bin+bins-1)%bins]*.7+hist[bin]*1.25+hist[(bin+1)%bins]*.7+hist[(bin+2)%bins]*.25;if(score<bestScore){bestScore=score;best=bin}}return(best+.5)/bins;
}
function rankMap(indexes,valueFor){const sorted=indexes.slice().sort((a,b)=>valueFor(a)-valueFor(b)||a-b),length=indexes.reduce((max,index)=>Math.max(max,index+1),1),out=new Float32Array(length),denominator=Math.max(1,sorted.length-1);for(let rank=0;rank<sorted.length;rank++)out[sorted[rank]]=rank/denominator;return out}
function axisTargets(colors,indexes,seam){const hueValue=index=>((colors[index]?.h||0)-seam+1)%1,hueRank=rankMap(indexes,hueValue),lightRank=rankMap(indexes,index=>colors[index]?.l??.5),tx=new Float32Array(colors.length),ty=new Float32Array(colors.length);for(const index of indexes){const color=colors[index]||{h:0,l:.5},hue=hueValue(index),light=color.l;tx[index]=HUE_ABSOLUTE_WEIGHT*hue+(1-HUE_ABSOLUTE_WEIGHT)*hueRank[index];ty[index]=LIGHT_ABSOLUTE_WEIGHT*(1-light)+(1-LIGHT_ABSOLUTE_WEIGHT)*(1-lightRank[index])}return{tx,ty}}
function nearestFree(used,cols,rows,targetX,targetY,blocked=null){
  const available=(x,y)=>{const slot=y*cols+x;return!used[slot]&&!(blocked?.[slot])},cx=Math.max(0,Math.min(cols-1,Math.round(targetX))),cy=Math.max(0,Math.min(rows-1,Math.round(targetY)));if(available(cx,cy))return[cx,cy];
  const maxRadius=Math.max(cols,rows);let bestX=cx,bestY=cy,bestScore=Infinity;for(let radius=1;radius<=maxRadius;radius++){let found=false;const left=Math.max(0,cx-radius),right=Math.min(cols-1,cx+radius),top=Math.max(0,cy-radius),bottom=Math.min(rows-1,cy+radius);const consider=(x,y)=>{if(!available(x,y))return;const dx=x-targetX,dy=y-targetY,score=dx*dx+dy*dy*1.2;if(score<bestScore){bestScore=score;bestX=x;bestY=y;found=true}};for(let x=left;x<=right;x++){consider(x,top);if(bottom!==top)consider(x,bottom)}for(let y=top+1;y<bottom;y++){consider(left,y);if(right!==left)consider(right,y)}if(found)return[bestX,bestY]}return blocked?nearestFree(used,cols,rows,targetX,targetY,null):[cx,cy];
}
function reserveCompactFamily(reserved,used,cols,rows,bounds,count){if(count<3||bounds.maxX<bounds.minX||bounds.maxY<bounds.minY)return false;const width=bounds.maxX-bounds.minX+1,height=bounds.maxY-bounds.minY+1,area=width*height;if(area>Math.ceil(count*1.65))return false;for(let py=bounds.minY;py<=bounds.maxY;py++)for(let px=bounds.minX;px<=bounds.maxX;px++){const slot=py*cols+px;if(!used[slot])reserved[slot]=1}return true}

async function loadFamilies(media){
  if(typeof Worker!=='function')return null;
  return new Promise(resolve=>{let settled=false;const finish=value=>{if(settled)return;settled=true;try{familyWorker.terminate()}catch{}resolve(value)};const familyWorker=new Worker(new URL(`./ai-global-multimodal-worker.js?v=${FAMILY_WORKER_REV}`,import.meta.url),{type:'module'});familyWorker.onerror=()=>finish(null);familyWorker.onmessage=event=>{const data=event.data||{};if(data.type==='progress'){post('progress',{...data,detail:`AI families · ${data.detail||'matching related media…'}`});return}if(data.type==='result')finish(data.result||null);else if(data.type==='error')finish(null)};familyWorker.postMessage({action:'sort',payload:{media}})})
}
function effectiveFamilyIds(media,families,hard){
  const out=new Int32Array(media.length);out.fill(-1);let next=0;for(const members of hard.groups){const id=next++;for(const index of members)out[index]=id}
  const groups=new Map();for(let index=0;index<media.length;index++){if(out[index]>=0)continue;const old=Number(families?.familyIds?.[index]);if(!Number.isInteger(old)||old<0)continue;let id=groups.get(old);if(id==null){id=next++;groups.set(old,id)}out[index]=id}return out;
}
function familyInfo(indexes,familyIds,order,media){
  const orderRank=new Int32Array(media.length);orderRank.fill(1e9);if(Array.isArray(order)){const byHash=new Map(media.map((item,index)=>[item.hash,index]));for(let rank=0;rank<order.length;rank++){const index=byHash.get(String(order[rank]));if(index!=null)orderRank[index]=rank}}
  const groups=new Map(),singles=[];for(const index of indexes){const id=Number(familyIds?.[index]);if(Number.isInteger(id)&&id>=0){let members=groups.get(id);if(!members)groups.set(id,members=[]);members.push(index)}else singles.push(index)}
  const multi=[];for(const members of groups.values()){members.sort((a,b)=>orderRank[a]-orderRank[b]||a-b);if(members.length>1)multi.push(members);else singles.push(members[0])}multi.sort((a,b)=>b.length-a.length||a[0]-b[0]);singles.sort((a,b)=>orderRank[a]-orderRank[b]||a-b);return{multi,singles};
}
function familyStrength(members,tx,ty){let mx=0,my=0;for(const index of members){mx+=tx[index];my+=ty[index]}mx/=members.length;my/=members.length;let spreadX=0,spreadY=0;for(const index of members){spreadX+=Math.abs(tx[index]-mx);spreadY+=Math.abs(ty[index]-my)}spreadX/=members.length;spreadY/=members.length;const xStrength=spreadX<.055?.92:spreadX<.11?.80:spreadX<.18?.60:spreadX<.28?.38:.16,yStrength=spreadY<.08?.82:spreadY<.18?.64:spreadY<.28?.42:.22;return{mx,my,xStrength,yStrength}}
function placeColorField(media,colors,indexes,seam,familyIds,order,x,y){
  if(!indexes.length)return{cols:0,rows:0,familyGroups:0,reservedFamilies:0};
  const slots=Math.max(indexes.length,Math.ceil(indexes.length/COLOR_OCCUPANCY)),cols=Math.max(16,Math.ceil(Math.sqrt(slots*COLOR_ASPECT))),rows=Math.max(1,Math.ceil(slots/cols)),used=new Uint8Array(cols*rows),reserved=new Uint8Array(cols*rows),{tx,ty}=axisTargets(colors,indexes,seam),{multi,singles}=familyInfo(indexes,familyIds,order,media);let placed=0,reservedFamilies=0;
  const put=(index,nx,ny)=>{const[px,py]=nearestFree(used,cols,rows,nx*Math.max(0,cols-1),ny*Math.max(0,rows-1),reserved);used[py*cols+px]=1;x[index]=px;y[index]=py;if(++placed%5000===0)post('progress',{done:placed,total:media.length,detail:`Placing color field · ${placed.toLocaleString()}…`,stage:'layout'});return[px,py]};
  for(const members of multi){abort();const family=familyStrength(members,tx,ty),bounds={minX:cols,minY:rows,maxX:-1,maxY:-1};for(let position=0;position<members.length;position++){const index=members[position],ring=position?Math.sqrt(position)*.0025:0,angle=position*2.399963229728653,nx=family.mx+(tx[index]-family.mx)*(1-family.xStrength)+Math.cos(angle)*ring,ny=family.my+(ty[index]-family.my)*(1-family.yStrength)+Math.sin(angle)*ring*.7,[px,py]=put(index,clamp(nx),clamp(ny));bounds.minX=Math.min(bounds.minX,px);bounds.maxX=Math.max(bounds.maxX,px);bounds.minY=Math.min(bounds.minY,py);bounds.maxY=Math.max(bounds.maxY,py)}if(reserveCompactFamily(reserved,used,cols,rows,bounds,members.length))reservedFamilies++}
  singles.sort((a,b)=>{const ca=colors[a]||{},cb=colors[b]||{},va=(ca.c||0)*5+(ca.f||0),vb=(cb.c||0)*5+(cb.f||0);return vb-va||Math.abs((ca.l??.5)-.5)-Math.abs((cb.l??.5)-.5)||String(media[a].hash).localeCompare(String(media[b].hash))});for(const index of singles){abort();put(index,tx[index],ty[index])}
  return{cols,rows,familyGroups:multi.length,reservedFamilies};
}
function placeNeutrals(media,colors,indexes,startX,familyIds,order,x,y){
  if(!indexes.length)return{cols:0,rows:0,familyGroups:0,reservedFamilies:0};
  const slots=Math.max(indexes.length,Math.ceil(indexes.length/NEUTRAL_OCCUPANCY)),cols=Math.max(4,Math.ceil(Math.sqrt(slots))),rows=Math.max(1,Math.ceil(slots/cols)),used=new Uint8Array(cols*rows),reserved=new Uint8Array(cols*rows),lightRank=rankMap(indexes,index=>colors[index]?.l??.5),{multi,singles}=familyInfo(indexes,familyIds,order,media),targetY=index=>LIGHT_ABSOLUTE_WEIGHT*(1-(colors[index]?.l??.5))+(1-LIGHT_ABSOLUTE_WEIGHT)*(1-lightRank[index]);let reservedFamilies=0;
  const placeGroup=(members,seed)=>{let meanY=0;for(const index of members)meanY+=targetY(index);meanY/=members.length;const baseX=.08+.84*hashNoise(String(seed)),bounds={minX:cols,minY:rows,maxX:-1,maxY:-1};for(let position=0;position<members.length;position++){const index=members[position],angle=position*2.399963229728653,ring=Math.sqrt(position)*.005,nx=clamp(baseX+Math.cos(angle)*ring),ny=clamp(meanY*.65+targetY(index)*.35+Math.sin(angle)*ring*.5),[px,py]=nearestFree(used,cols,rows,nx*Math.max(0,cols-1),ny*Math.max(0,rows-1),reserved);used[py*cols+px]=1;x[index]=startX+px;y[index]=py;bounds.minX=Math.min(bounds.minX,px);bounds.maxX=Math.max(bounds.maxX,px);bounds.minY=Math.min(bounds.minY,py);bounds.maxY=Math.max(bounds.maxY,py)}if(reserveCompactFamily(reserved,used,cols,rows,bounds,members.length))reservedFamilies++};
  for(const members of multi){abort();placeGroup(members,media[members[0]]?.hash||members[0])}for(const index of singles){abort();const nx=hashNoise(String(media[index]?.hash||index)),ny=targetY(index),[px,py]=nearestFree(used,cols,rows,nx*Math.max(0,cols-1),ny*Math.max(0,rows-1),reserved);used[py*cols+px]=1;x[index]=startX+px;y[index]=py}
  return{cols,rows,familyGroups:multi.length,reservedFamilies};
}

function packingIds(hard,logicalX,logicalY,n){
  const ids=new Int32Array(n);ids.fill(-1);let next=0;for(const group of hard.groups){const ordered=group.slice().sort((a,b)=>(Number(logicalY[a])||0)-(Number(logicalY[b])||0)||(Number(logicalX[a])||0)-(Number(logicalX[b])||0)||a-b);for(let start=0;start<ordered.length;start+=ATOMIC_CHUNK){const id=next++;for(const index of ordered.slice(start,start+ATOMIC_CHUNK))ids[index]=id}}return ids;
}
function layoutRatio(item){return Math.max(PACK_MIN_RATIO,Math.min(PACK_MAX_RATIO,mediaRatio(item)))}
function fitAspect(item,boxW,boxH){const source=mediaRatio(item);if(source>=EXTREME_RATIO||source<=1/EXTREME_RATIO)return[boxW,boxH];const boxRatio=boxW/Math.max(.0001,boxH);return source>=boxRatio?[boxW,boxW/source]:[boxH*source,boxH]}
function blockInfo(indexes,packingGroupIds,logicalX,logicalY){
  const groups=new Map();for(const index of indexes){const id=Number(packingGroupIds?.[index]);if(id<0)continue;let members=groups.get(id);if(!members)groups.set(id,members=[]);members.push(index)}
  const rowFor=new Map(),xFor=new Map();for(const[id,members]of groups){if(members.length<2)continue;let x=0,y=0;for(const index of members){x+=Number(logicalX[index])||0;y+=Number(logicalY[index])||0}x/=members.length;y/=members.length;rowFor.set(id,Math.round(y));xFor.set(id,x)}return{groups,rowFor,xFor};
}
function sortRow(row,packingGroupIds,logicalX,info){
  const blocks=new Map(),singles=[];for(const index of row){const id=Number(packingGroupIds?.[index]);if(id>=0&&info.groups.get(id)?.length>1){let members=blocks.get(id);if(!members)blocks.set(id,members=[]);members.push(index)}else singles.push(index)}
  const entries=singles.map(index=>({x:Number(logicalX[index])||0,members:[index]}));for(const[id,members]of blocks){members.sort((a,b)=>(Number(logicalX[a])||0)-(Number(logicalX[b])||0)||a-b);entries.push({x:info.xFor.get(id)??0,members})}entries.sort((a,b)=>a.x-b.x||a.members[0]-b.members[0]);return entries.flatMap(entry=>entry.members);
}
function logicalRows(indexes,logicalX,logicalY,packingGroupIds){
  const info=blockInfo(indexes,packingGroupIds,logicalX,logicalY),grouped=new Map();for(const index of indexes){const id=Number(packingGroupIds?.[index]),key=id>=0&&info.rowFor.has(id)?info.rowFor.get(id):Math.round(Number(logicalY[index])||0);let row=grouped.get(key);if(!row)grouped.set(key,row=[]);row.push(index)}return{rows:[...grouped.entries()].sort((a,b)=>a[0]-b[0]).map(([,row])=>sortRow(row,packingGroupIds,logicalX,info)),info};
}
function packSection(media,indexes,logicalX,logicalY,packingGroupIds,aspect,originX,outX,outY,renderW,renderH){
  if(!indexes.length)return{width:0,height:0,rows:0};
  const totalRatio=indexes.reduce((sum,index)=>sum+layoutRatio(media[index]),0),targetWidth=Math.max(4,Math.sqrt(Math.max(1,totalRatio)*Math.max(.7,Number(aspect)||1)));let{rows,info}=logicalRows(indexes,logicalX,logicalY,packingGroupIds);
  if(rows.length>1){const merged=[];let pending=[],pendingRatio=0;const flush=()=>{if(!pending.length)return;merged.push(sortRow(pending,packingGroupIds,logicalX,info));pending=[];pendingRatio=0};for(let rowIndex=0;rowIndex<rows.length;rowIndex++){const row=rows[rowIndex],rowRatio=row.reduce((sum,index)=>sum+layoutRatio(media[index]),0);if(rowRatio>=targetWidth*.52){flush();merged.push(row);continue}pending.push(...row);pendingRatio+=rowRatio;if(pendingRatio>=targetWidth*.78||rowIndex===rows.length-1)flush()}rows=merged}
  let top=.02,maxRight=originX;
  for(const row of rows){abort();const sum=row.reduce((total,index)=>total+layoutRatio(media[index]),0),gaps=PACK_GAP*Math.max(0,row.length-1),usable=Math.max(.1,targetWidth-gaps),height=Math.max(PACK_MIN_ROW_HEIGHT,Math.min(PACK_MAX_ROW_HEIGHT,usable/Math.max(.001,sum))),rowWidth=sum*height+gaps;let left=originX+Math.max(0,(targetWidth-rowWidth)/2);for(const index of row){const boxW=layoutRatio(media[index])*height,boxH=height,[width,actualHeight]=fitAspect(media[index],boxW,boxH),centerX=left+boxW/2,centerY=top+boxH/2;outX[index]=centerX-.5;outY[index]=centerY-.5;renderW[index]=width;renderH[index]=actualHeight;left+=boxW+PACK_GAP}maxRight=Math.max(maxRight,left-PACK_GAP);top+=height+PACK_GAP}
  return{width:Math.max(targetWidth,maxRight-originX),height:Math.max(0,top-PACK_GAP),rows:rows.length};
}

async function build(media){
  const usable=Array.isArray(media)?media.filter(item=>HASH_RE.test(String(item?.hash||''))):[];
  if(!usable.length)return{kind:'map',x:new Float32Array(),y:new Float32Array(),renderW:new Float32Array(),renderH:new Float32Array(),worldW:1,worldH:1,labels:[],detail:'Color Map · no media'};
  const[visual,families]=await Promise.all([loadVisual(usable),loadFamilies(usable).catch(()=>null)]);abort();
  const hard=hardGroups(usable,visual);post('progress',{done:usable.length,total:usable.length,detail:`Hard visual clusters · ${hard.count.toLocaleString()} groups · ${hard.locked.toLocaleString()} media locked…`,stage:'series'});
  const familyIds=effectiveFamilyIds(usable,families,hard),colorful=[],neutrals=[];for(let index=0;index<usable.length;index++)(neutral(visual.colors[index])?neutrals:colorful).push(index);
  const seam=hueSeam(visual.colors),logicalX=new Float32Array(usable.length),logicalY=new Float32Array(usable.length);logicalX.fill(-1);logicalY.fill(-1);
  post('progress',{done:0,total:usable.length,detail:'Building hue × lightness field with hard visual clusters…',stage:'layout'});
  const field=placeColorField(usable,visual.colors,colorful,seam,familyIds,families?.order,logicalX,logicalY),neutralStart=field.cols?field.cols+NEUTRAL_GAP:0,neutralField=placeNeutrals(usable,visual.colors,neutrals,neutralStart,familyIds,families?.order,logicalX,logicalY),atomicIds=packingIds(hard,logicalX,logicalY,usable.length);
  post('progress',{done:usable.length,total:usable.length,detail:'Packing dense rows without splitting visual clusters…',stage:'packing'});
  const x=new Float32Array(usable.length),y=new Float32Array(usable.length),renderW=new Float32Array(usable.length),renderH=new Float32Array(usable.length);x.fill(-1);y.fill(-1);
  const colorPack=packSection(usable,colorful,logicalX,logicalY,atomicIds,COLOR_ASPECT,.02,x,y,renderW,renderH),neutralOrigin=.02+colorPack.width+(neutrals.length?PACK_SECTION_GAP:0),neutralPack=packSection(usable,neutrals,logicalX,logicalY,atomicIds,1,neutralOrigin,x,y,renderW,renderH);
  const worldW=Math.max(1,.04+colorPack.width+(neutrals.length?PACK_SECTION_GAP+neutralPack.width:0)),worldH=Math.max(1,.04,Math.max(colorPack.height,neutralPack.height)+.04);
  return{kind:'map',x,y,renderW,renderH,worldW,worldH,labels:[],preserveRows:true,detail:`Color Map · adaptive hue × lightness · hard visual clusters · ${hard.count.toLocaleString()} repeated groups / ${hard.locked.toLocaleString()} media · ${field.familyGroups.toLocaleString()} AI families · ${neutrals.length.toLocaleString()} neutral`};
}

self.onmessage=async event=>{
  const data=event.data||{};if(data.action==='cancel'){canceled=true;return}if(data.action!=='build')return;canceled=false;
  try{const media=Array.isArray(data.payload?.media)?data.payload.media:[],result=await build(media);if(!canceled)post('result',{result})}catch(error){post('error',{error:error?.message||String(error),aborted:error?.name==='AbortError'})}
};
