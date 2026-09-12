const DB_NAME='mochimono-visual-similarity';
const DB_VERSION=1;
const STORE='fingerprints';
const ROBUST_VERSION='phash32-dct16-v1';
const HASH256_RE=/^[0-9a-f]{64}$/;
const FAMILY_LINK_DISTANCE=72;
const FAMILY_DIAMETER=96;
const FAMILY_ASPECT_DISTANCE=1;
const POPCOUNT16=new Uint8Array(1<<16);
for(let value=1;value<POPCOUNT16.length;value++)POPCOUNT16[value]=POPCOUNT16[value>>1]+(value&1);
const words=value=>Array.from({length:16},(_,index)=>parseInt(value.slice(index*4,index*4+4),16));
const bytes=value=>Array.from({length:32},(_,index)=>parseInt(value.slice(index*2,index*2+2),16));
function hamming(left,right){let total=0;for(let index=0;index<left.length;index++)total+=POPCOUNT16[left[index]^right[index]];return total}
function aspect(item){return Math.max(1e-6,(Number(item?.width)||1)/(Number(item?.height)||1))}
function aspectDistance(a,b){return Math.abs(Math.log2(a/b))}
function byteNeighbors2(value,visit){visit(value);for(let a=0;a<8;a++){const one=value^(1<<a);visit(one);for(let b=a+1;b<8;b++)visit(one^(1<<b))}}
function openDb(){return new Promise((resolve,reject)=>{const request=indexedDB.open(DB_NAME,DB_VERSION);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)})}
async function loadRobust(){
  const db=await openDb();
  try{
    if(!db.objectStoreNames.contains(STORE))return new Map();
    const rows=await new Promise((resolve,reject)=>{const request=db.transaction(STORE,'readonly').objectStore(STORE).getAll();request.onsuccess=()=>resolve(request.result||[]);request.onerror=()=>reject(request.error)});
    return new Map(rows.filter(row=>row?.robustVersion===ROBUST_VERSION&&HASH256_RE.test(String(row.robust||''))).map(row=>[String(row.hash),String(row.robust)]));
  }finally{db.close()}
}
function representative(items,robust){
  for(const item of items){const hash=robust.get(String(item?.hash||''));if(HASH256_RE.test(hash))return{hash,words:words(hash),bytes:bytes(hash),aspect:aspect(item)}}
  return null;
}
async function rankFamilies(result){
  const order=Array.isArray(result?.order)?result.order:[],info=Array.isArray(result?.groupInfo)?result.groupInfo:[];
  if(info.length<2||!order.length)return result;
  const robust=await loadRobust();
  const groups=info.map((entry,index)=>{const start=Math.max(0,Number(entry.start)||0),size=Math.max(0,Number(entry.size)||0),items=order.slice(start,start+size);return{entry,index,items,size:items.length,rep:representative(items,robust)}});
  const buckets=Array.from({length:32},()=>new Map());
  for(let index=0;index<groups.length;index++){
    const rep=groups[index].rep;if(!rep)continue;
    for(let block=0;block<32;block++){let list=buckets[block].get(rep.bytes[block]);if(!list)buckets[block].set(rep.bytes[block],list=[]);list.push(index)}
  }
  const pairs=[];
  for(let index=0;index<groups.length;index++){
    const rep=groups[index].rep;if(!rep)continue;
    const candidates=new Set();
    for(let block=0;block<32;block++)byteNeighbors2(rep.bytes[block],key=>{for(const other of buckets[block].get(key)||[])if(other>index)candidates.add(other)});
    for(const other of candidates){const target=groups[other].rep;if(!target||aspectDistance(rep.aspect,target.aspect)>FAMILY_ASPECT_DISTANCE)continue;const distance=hamming(rep.words,target.words);if(distance<=FAMILY_LINK_DISTANCE)pairs.push({left:index,right:other,distance})}
  }
  const parent=new Int32Array(groups.length),members=Array.from({length:groups.length},(_,index)=>[index]);for(let i=0;i<parent.length;i++)parent[i]=i;
  const find=value=>{let root=value;while(parent[root]!==root)root=parent[root];while(parent[value]!==value){const next=parent[value];parent[value]=root;value=next}return root};
  const canMerge=(left,right)=>{for(const a of members[left])for(const b of members[right]){const ra=groups[a].rep,rb=groups[b].rep;if(!ra||!rb)return false;if(aspectDistance(ra.aspect,rb.aspect)>FAMILY_ASPECT_DISTANCE)return false;if(hamming(ra.words,rb.words)>FAMILY_DIAMETER)return false}return true};
  pairs.sort((a,b)=>a.distance-b.distance||(groups[b.left].size+groups[b.right].size)-(groups[a.left].size+groups[a.right].size));
  for(const pair of pairs){let left=find(pair.left),right=find(pair.right);if(left===right||!canMerge(left,right))continue;if(members[left].length<members[right].length)[left,right]=[right,left];parent[right]=left;members[left].push(...members[right]);members[right]=[]}
  const families=[];
  for(let index=0;index<groups.length;index++)if(find(index)===index&&members[index].length){const indexes=members[index].slice().sort((a,b)=>groups[a].index-groups[b].index),total=indexes.reduce((sum,value)=>sum+groups[value].size,0),largest=indexes.reduce((max,value)=>Math.max(max,groups[value].size),0);families.push({indexes,total,largest,first:indexes[0]})}
  families.sort((a,b)=>b.total-a.total||b.largest-a.largest||a.first-b.first);
  const newOrder=[],groupInfo=[],groupByHash=[];let cursor=0,id=0;
  for(const family of families)for(const groupIndex of family.indexes){const group=groups[groupIndex];newOrder.push(...group.items);groupInfo.push({...group.entry,id,start:cursor,groupSize:group.size,size:family.total,familySize:family.total,familyGroups:family.indexes.length});for(const item of group.items)groupByHash.push([String(item.hash),id]);cursor+=group.size;id++}
  return{...result,order:newOrder,groupInfo,groupByHash};
}

let child=null;
self.onmessage=event=>{
  child?.terminate();
  child=new Worker(new URL('./similarity-group-worker-core.js',import.meta.url),{type:'module'});
  child.onerror=error=>self.postMessage({error:error.message||'Similarity worker failed'});
  child.onmessage=async message=>{
    const data=message.data||{};
    if(!data.result){self.postMessage(data);return}
    try{self.postMessage({result:await rankFamilies(data.result)})}catch{self.postMessage(data)}
    child?.terminate();child=null;
  };
  child.postMessage(event.data||{});
};
