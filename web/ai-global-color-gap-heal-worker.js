const VIS_DB='mochimono-visual-similarity',VIS_VERSION=1,VIS_STORE='fingerprints';
const HASH_RE=/^[a-f0-9]{64}$/,ROBUST_RE=/^[a-f0-9]{64}$/;
const TEMPLATE_VERSION='template12-v1',TEMPLATE_DIM=216,COLOR_DIM=56,WINDOW=28;
let canceled=false;
const post=(type,payload={})=>self.postMessage({type,...payload});
const progress=(done,total,detail)=>post('progress',{done,total,detail,stage:'gap-heal'});
const abort=()=>{if(canceled)throw new DOMException('Aborted','AbortError')};

function openDb(){return new Promise((resolve,reject)=>{const q=indexedDB.open(VIS_DB,VIS_VERSION);q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error)})}
async function loadRows(wanted){const db=await openDb(),rows=new Map;try{const q=db.transaction(VIS_STORE,'readonly').objectStore(VIS_STORE).openCursor();await new Promise((resolve,reject)=>{q.onerror=()=>reject(q.error);q.onsuccess=()=>{abort();const c=q.result;if(!c)return resolve();const row=c.value||{},hash=String(row.hash||'');if(wanted.has(hash))rows.set(hash,row);c.continue()}})}finally{db.close()}return rows}

function aspect(media,index){const w=Number(media[index]?.width)||0,h=Number(media[index]?.height)||0;return w>0&&h>0?w/h:1}
function aspectDistance(media,a,b){return Math.abs(Math.log2(aspect(media,a)/aspect(media,b)))}
function template(row){return row?.experimentalTemplateVersion===TEMPLATE_VERSION&&row.experimentalTemplate?.length===TEMPLATE_DIM?row.experimentalTemplate:null}
function templateMean(value){if(!value)return 0;let sum=0;for(let i=0;i<144;i++)sum+=Number(value[i])||0;return sum/144}
function templateDistance(a,meanA,b,meanB){if(!a||!b)return 1;let luma=0,chroma=0;for(let p=0;p<144;p++){const d=((a[p]-meanA)-(b[p]-meanB))/255;luma+=d*d}for(let p=144;p<TEMPLATE_DIM;p++){const d=(a[p]-b[p])/255;chroma+=d*d}return Math.sqrt(luma/144)*.65+Math.sqrt(chroma/(TEMPLATE_DIM-144))*.25+Math.abs(meanA-meanB)/255*.10}
function colorVector(row){const flow=row?.aiColorFlow;if(!flow||!Array.isArray(flow.v)||flow.v.length!==COLOR_DIM)return null;return flow.v}
function colorDistance(a,b){if(!a||!b)return 1;let dot=0,aa=0,bb=0;for(let i=0;i<COLOR_DIM;i++){const x=Number(a[i])||0,y=Number(b[i])||0;dot+=x*y;aa+=x*x;bb+=y*y}const n=Math.sqrt(aa*bb);return n?Math.max(0,1-dot/n):1}
const POP=new Uint8Array(1<<16);for(let i=1;i<POP.length;i++)POP[i]=POP[i>>1]+(i&1);
function robust(row){const value=String(row?.robust||'').toLowerCase();if(!ROBUST_RE.test(value))return null;const out=new Uint16Array(16);for(let i=0;i<16;i++)out[i]=parseInt(value.slice(i*4,i*4+4),16);return out}
function robustDistance(a,b){if(!a||!b)return 256;let n=0;for(let i=0;i<16;i++)n+=POP[a[i]^b[i]];return n}

function descriptor(row){const t=template(row);return{template:t,mean:templateMean(t),color:colorVector(row),robust:robust(row)}}
function metrics(media,desc,a,b){if(aspectDistance(media,a,b)>.24)return{ok:false,t:1,c:1,r:256};const A=desc[a],B=desc[b],t=templateDistance(A?.template,A?.mean||0,B?.template,B?.mean||0),c=colorDistance(A?.color,B?.color),r=robustDistance(A?.robust,B?.robust);return{ok:true,t,c,r}}
function strictPair(media,desc,a,b){const m=metrics(media,desc,a,b);if(!m.ok)return false;if(m.t<=.022)return true;if(m.t<=.047&&m.c<=.14)return true;if(m.t<=.064&&m.c<=.075)return true;if(m.r<=30&&m.t<=.09)return true;if(m.r<=52&&m.t<=.072&&m.c<=.18)return true;return false}
function pairCost(media,desc,a,b){const m=metrics(media,desc,a,b);if(!m.ok)return 10;return m.t*5+Math.min(.5,m.c)*1.5+Math.min(1,m.r/96)*.35}

class UF{constructor(n){this.p=Int32Array.from({length:n},(_,i)=>i);this.r=new Uint8Array(n)}find(x){let r=x;while(this.p[r]!==r)r=this.p[r];while(this.p[x]!==x){const next=this.p[x];this.p[x]=r;x=next}return r}join(a,b){a=this.find(a);b=this.find(b);if(a===b)return;if(this.r[a]<this.r[b])[a,b]=[b,a];this.p[b]=a;if(this.r[a]===this.r[b])this.r[a]++}}

function bestRepresentative(media,desc,members){const sample=members.length<=24?members:Array.from({length:24},(_,i)=>members[Math.floor((i+.5)*members.length/24)]);let best=sample[0],bestScore=Infinity;for(const candidate of sample){let score=0;for(const other of sample)if(other!==candidate)score+=pairCost(media,desc,candidate,other);if(score<bestScore){bestScore=score;best=candidate}}return best}
function refineComponent(media,desc,members,position){if(members.length<3)return[members.slice().sort((a,b)=>position[a]-position[b])];const remaining=new Set(members),out=[];while(remaining.size){abort();const pool=[...remaining],rep=bestRepresentative(media,desc,pool),cluster=[];for(const item of pool)if(item===rep||strictPair(media,desc,rep,item))cluster.push(item);if(cluster.length===1&&pool.length>1){let best=-1,cost=Infinity;for(const item of pool){if(item===rep)continue;const value=pairCost(media,desc,rep,item);if(value<cost){cost=value;best=item}}if(best>=0&&cost<.7)cluster.push(best)}for(const item of cluster)remaining.delete(item);cluster.sort((a,b)=>position[a]-position[b]);out.push(cluster)}return out}

function remapRail(result,oldOrder,newOrder){if(!Array.isArray(result?.rail)||!result.rail.length)return[];const newPos=new Map(newOrder.map((hash,index)=>[hash,index]));return result.rail.map(entry=>{const old=Math.max(0,Math.min(oldOrder.length-1,Number(entry.index)||0)),hash=oldOrder[old];return{...entry,index:newPos.get(hash)??old}}).sort((a,b)=>a.index-b.index)}

async function heal(payload){const media=Array.isArray(payload?.media)?payload.media.filter(item=>HASH_RE.test(String(item?.hash||''))):[],result=payload?.result||{};if(!media.length)return result;const oldOrder=Array.from(result.order||[],String),byHash=new Map(media.map((item,index)=>[item.hash,index])),base=oldOrder.map(hash=>byHash.get(hash)).filter(Number.isInteger);if(base.length!==media.length)throw new Error('Color gap healer received incomplete order');
progress(0,media.length,'Checking Color order for short visual gaps…');const rows=await loadRows(new Set(oldOrder)),desc=media.map(item=>descriptor(rows.get(item.hash))),uf=new UF(media.length),position=new Int32Array(media.length);for(let p=0;p<base.length;p++)position[base[p]]=p;
let comparisons=0;for(let p=0;p<base.length;p++){abort();const a=base[p],end=Math.min(base.length,p+WINDOW+1);for(let q=p+1;q<end;q++){const b=base[q];if(strictPair(media,desc,a,b))uf.join(a,b);comparisons++}if(p&&p%5000===0)progress(p,media.length,`Healing short visual gaps · ${p.toLocaleString()} / ${media.length.toLocaleString()}…`)}
const components=new Map;for(let i=0;i<media.length;i++){const root=uf.find(i);if(!components.has(root))components.set(root,[]);components.get(root).push(i)}const refined=[];for(const members of components.values())if(members.length>1)refined.push(...refineComponent(media,desc,members,position).filter(group=>group.length>1));
const groupOf=new Int32Array(media.length);groupOf.fill(-1);refined.forEach((group,id)=>group.forEach(index=>groupOf[index]=id));const emitted=new Uint8Array(refined.length),next=[];for(const index of base){const id=groupOf[index];if(id<0){next.push(index);continue}if(emitted[id])continue;emitted[id]=1;next.push(...refined[id])}if(next.length!==media.length)throw new Error('Color gap healer lost media');const order=next.map(index=>media[index].hash),moved=order.reduce((n,hash,i)=>n+(hash!==oldOrder[i]?1:0),0),locked=refined.reduce((sum,group)=>sum+group.length,0);progress(media.length,media.length,`Color gaps healed · ${refined.length.toLocaleString()} strict runs · ${locked.toLocaleString()} media locked · ${moved.toLocaleString()} positions changed`);return{...result,order,rail:remapRail(result,oldOrder,order),gapHealedRuns:refined.length,gapHealedMedia:locked,gapHealedMoved:moved}}

self.onmessage=async event=>{const data=event.data||{};if(data.action==='cancel'){canceled=true;return}if(data.action!=='heal')return;canceled=false;try{const result=await heal(data.payload||{});abort();post('result',{result})}catch(error){post('error',{error:error?.name==='AbortError'?'Canceled':String(error?.message||error),aborted:error?.name==='AbortError'})}};
