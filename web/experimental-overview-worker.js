const DB='mochimono-visual-similarity',VERSION=1,STORE='fingerprints';
const TEMPLATE_VERSION='template12-v1',TEMPLATE_N=12,TEMPLATE_DIM=216,EDGE=8,PIXELS=EDGE*EDGE*4;
let canceled=false;

function clamp(value){return Math.max(0,Math.min(255,Math.round(value)))}
function openDb(){return new Promise((resolve,reject)=>{const request=indexedDB.open(DB,VERSION);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)})}
function validTemplate(row){return row?.experimentalTemplateVersion===TEMPLATE_VERSION&&row.experimentalTemplate?.length===TEMPLATE_DIM}
function reconstruct(template,target,offset){
  for(let oy=0;oy<EDGE;oy++)for(let ox=0;ox<EDGE;ox++){
    const x=Math.min(TEMPLATE_N-1,Math.floor((ox+.5)*TEMPLATE_N/EDGE)),y=Math.min(TEMPLATE_N-1,Math.floor((oy+.5)*TEMPLATE_N/EDGE));
    const luma=Number(template[y*TEMPLATE_N+x])||0,bx=Math.floor(x/2),by=Math.floor(y/2),chroma=144+(by*6+bx)*2;
    const rg=((Number(template[chroma])||127)-127)*2,bg=((Number(template[chroma+1])||127)-127)*2;
    const g=luma-.299*rg-.114*bg,p=offset+(oy*EDGE+ox)*4;
    target[p]=clamp(g+rg);target[p+1]=clamp(g);target[p+2]=clamp(g+bg);target[p+3]=255;
  }
}

self.onmessage=async event=>{
  const data=event.data||{};
  if(data.action==='cancel'){canceled=true;return}
  if(data.action!=='build')return;
  canceled=false;
  const hashes=Array.isArray(data.hashes)?data.hashes:[],byHash=new Map(hashes.map((hash,index)=>[String(hash),index]));
  const pixels=new Uint8Array(hashes.length*PIXELS),available=new Uint8Array(hashes.length);
  let found=0,db;
  try{
    db=await openDb();
    const store=db.transaction(STORE,'readonly').objectStore(STORE);
    const rows=await new Promise((resolve,reject)=>{
      const request=store.getAll();
      request.onsuccess=()=>resolve(request.result||[]);
      request.onerror=()=>reject(request.error);
    });
    if(canceled)return;
    for(let scanned=0;scanned<rows.length;scanned++){
      if(canceled)return;
      const row=rows[scanned]||{},index=byHash.get(String(row.hash||''));
      if(index!=null&&validTemplate(row)){reconstruct(row.experimentalTemplate,pixels,index*PIXELS);available[index]=1;found++}
      if(scanned&&scanned%10000===0)self.postMessage({type:'progress',found,scanned,total:hashes.length});
    }
    if(canceled)return;
    self.postMessage({type:'result',pixels,available,found,edge:EDGE},[pixels.buffer,available.buffer]);
  }catch(error){if(!canceled)self.postMessage({type:'error',error:String(error?.message||error)})}
  finally{db?.close?.()}
};
