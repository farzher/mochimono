import { ensureBrowserThumbnail } from './browser-thumbnail-fallback.js';
import { ExperimentalWebGLMapRenderer as BaseRenderer } from './experimental-webgl-map-v1.js';

const LOAD_CONCURRENCY=20;
const SMALL_EDGE=64;
const SMALL_PAGES=8;
const SMALL_SCREEN_PX=2.5;
const DETAIL_SCREEN_PX=48;
const FULL_THUMB_EDGE=512;
const FULL_THUMB_PAGES=20;
const ORIGINAL_SCREEN_PX=220;
const ORIGINAL_MAX=12;
const ORIGINAL_CONCURRENCY=3;
const ORIGINAL_MIN_EDGE=1024;
const ORIGINAL_MAX_EDGE=4096;

function aspectSize(item,maxSide){
  const width=Math.max(1,Number(item?.width)||1),height=Math.max(1,Number(item?.height)||1),ratio=width/height;
  return ratio>=1?[maxSide,maxSide/ratio]:[maxSide*ratio,maxSide];
}
function bitmapSize(item,edge){
  const width=Math.max(1,Number(item?.width)||1),height=Math.max(1,Number(item?.height)||1),scale=Math.min(1,edge/Math.max(width,height));
  return[Math.max(1,Math.round(width*scale)),Math.max(1,Math.round(height*scale))];
}
function sameMediaOrder(current,next){
  if(!Array.isArray(current)||!Array.isArray(next)||current.length!==next.length)return false;
  for(let index=0;index<next.length;index++)if(String(current[index]?.hash||'')!==String(next[index]?.hash||''))return false;
  return true;
}
function fallbackRecord(item){
  if(!item?.hash||!item?.type)return null;
  return{hash:item.hash,filename:item.filename||'',mime:item.mime||'',kind:item.type==='video'?'video':'image',urgent:true,width:Number(item.width)||0,height:Number(item.height)||0};
}

export class ExperimentalWebGLMapRenderer extends BaseRenderer{
  constructor(canvas,options={}){
    super(canvas,options);
    this.originalEntries=new Map();this.originalQueue=[];this.originalQueued=new Set();this.originalDesired=new Set();this.originalLoads=0;this.originalToken=1;
    this.originalBuffer=this.gl.createBuffer();this.cameraSettleTimer=0;this.maxGeometryHalfCells=0;this.sceneMediaChanged=true;
    this.configureTiers();
    this.canvas.addEventListener('webglcontextrestored',()=>{this.configureTiers();this.originalEntries=new Map();this.originalQueue=[];this.originalQueued=new Set();this.originalDesired=new Set();this.originalLoads=0;this.originalToken++;this.originalBuffer=this.gl.createBuffer();this.settle()});
  }

  configureTiers(){
    if(this.tiers?.small){this.tiers.small.edge=SMALL_EDGE;this.tiers.small.maxPages=SMALL_PAGES}
    if(this.tiers?.detail){this.tiers.detail.edge=FULL_THUMB_EDGE;this.tiers.detail.maxPages=FULL_THUMB_PAGES}
  }

  clearOriginals(deleteTextures=true){
    this.originalToken=(this.originalToken||0)+1;this.originalQueue?.splice(0);this.originalQueued?.clear();this.originalDesired?.clear();
    if(deleteTextures&&this.gl&&this.originalEntries)for(const entry of this.originalEntries.values())this.gl.deleteTexture(entry.texture);
    this.originalEntries?.clear();
  }
  resetTextures(){if(this.originalEntries)this.clearOriginals();super.resetTextures();this.configureTiers()}
  destroy(){clearTimeout(this.cameraSettleTimer);this.clearOriginals();if(this.gl&&this.originalBuffer)this.gl.deleteBuffer(this.originalBuffer);super.destroy()}

  setCamera(panX,panY,zoom){
    super.setCamera(panX,panY,zoom);
    clearTimeout(this.cameraSettleTimer);
    this.cameraSettleTimer=setTimeout(()=>{this.cameraSettleTimer=0;this.settle()},42);
  }

  setScene(scene){
    const nextMedia=Array.isArray(scene?.media)?scene.media:[],preserveTextures=sameMediaOrder(this.media,nextMedia);
    this.sceneMediaChanged=!preserveTextures;
    this.configureTiers();
    if(preserveTextures){
      const resetTextures=this.resetTextures;
      this.resetTextures=()=>{};
      try{super.setScene(scene)}finally{this.resetTextures=resetTextures}
    }else super.setScene(scene);
    this.configureTiers();this.baseSide=this.cell*.96;this.maxGeometryHalfCells=0;
    const renderW=this.result?.renderW,renderH=this.result?.renderH,instances=new Float32Array(this.media.length*8);let count=0;
    for(let index=0;index<this.media.length;index++){
      if(!this.valid[index])continue;
      const offset=index*4,packedW=Number(renderW?.[index]),packedH=Number(renderH?.[index]);
      const[width,height]=packedW>0&&packedH>0?[packedW*this.cell,packedH*this.cell]:aspectSize(this.media[index],this.baseSide);
      this.geometry[offset+2]=width;this.geometry[offset+3]=height;this.maxGeometryHalfCells=Math.max(this.maxGeometryHalfCells,width/this.cell*.5,height/this.cell*.5);
      const at=count*8;instances[at]=this.geometry[offset];instances[at+1]=this.geometry[offset+1];instances[at+2]=width;instances[at+3]=height;instances[at+4]=0;instances[at+5]=0;instances[at+6]=1;instances[at+7]=1;count++;
    }
    this.placeholderCount=count;this.gl.bindBuffer(this.gl.ARRAY_BUFFER,this.placeholderBuffer);this.gl.bufferData(this.gl.ARRAY_BUFFER,instances.subarray(0,count*8),this.gl.STATIC_DRAW);
    for(const tier of Object.values(this.tiers))for(const page of tier.pages)page.dirty=true;
    this.requestDraw();
  }

  visibleIndexes(overscanCells=2){return super.visibleIndexes(overscanCells+(this.maxGeometryHalfCells||0))}

  settle(){
    if(!this.result||this.lost)return;
    const screenPx=this.screenItemSize(),visible=this.visibleIndexes(screenPx<12?4:3);this.visibleCount=visible.length;this.visibleSet=new Set(visible);this.desired.clear();
    if(screenPx<SMALL_SCREEN_PX||!visible.length){this.queue.length=0;this.queued.clear();this.originalDesired.clear();this.requestDraw();return}
    const tier=screenPx>=DETAIL_SCREEN_PX?this.tiers.detail:this.tiers.small,maxWanted=Math.min(tier.capacity(),tier.name==='small'?10000:96);
    const worldCenterX=(this.canvas.clientWidth*.5-this.panX)/this.zoom,worldCenterY=(this.canvas.clientHeight*.5-this.panY)/this.zoom;
    const wanted=visible.map(index=>{const o=index*4,dx=this.geometry[o]-worldCenterX,dy=this.geometry[o+1]-worldCenterY;return[index,dx*dx+dy*dy]}).sort((a,b)=>a[1]-b[1]).slice(0,maxWanted).map(entry=>entry[0]);
    for(const index of wanted){this.desired.set(index,tier.name);if(!tier.get(index))this.enqueue(index,tier)}
    this.pump();this.settleOriginals(visible,worldCenterX,worldCenterY);this.requestDraw();
  }

  pump(){
    while(this.activeLoads<LOAD_CONCURRENCY&&this.queue.length){const job=this.queue.shift();this.queued.delete(job.key);if(job.sceneToken!==this.sceneToken||this.desired.get(job.index)!==job.tier.name||job.tier.entries.has(job.index))continue;this.activeLoads++;this.load(job).finally(()=>{this.activeLoads--;this.pump()})}
  }

  async load(job){
    const item=this.media[job.index];if(!item)return;
    try{
      const suffix=job.tier.name==='detail'?'':`&edge=${job.tier.edge}`,url=`/api/thumbs/${encodeURIComponent(item.hash)}?v=${this.thumbVersion}${suffix}`;
      let response=await fetch(url,{cache:'force-cache'});
      if(response.status===404){
        const record=fallbackRecord(item),fallback=record?await ensureBrowserThumbnail(record).catch(()=>null):null;
        if(fallback){
          window.dispatchEvent(new CustomEvent('mochimono:browser-thumbnail-ready',{detail:{hash:item.hash,...fallback}}));
          if(job.sceneToken!==this.sceneToken||this.desired.get(job.index)!==job.tier.name)return;
          response=await fetch(url,{cache:'reload'});
        }
      }
      if(response.status===404&&window.mochimonoThumbnails?.ensureHashes){const ensured=await window.mochimonoThumbnails.ensureHashes([item.hash],{background:false});if(!ensured?.ready?.includes(item.hash))return;if(job.sceneToken!==this.sceneToken||this.desired.get(job.index)!==job.tier.name)return;response=await fetch(url,{cache:'reload'})}
      if(!response.ok)throw new Error(`Thumbnail ${response.status}`);const blob=await response.blob();if(job.sceneToken!==this.sceneToken||this.desired.get(job.index)!==job.tier.name)return;
      const[width,height]=bitmapSize(item,job.tier.edge),bitmap=await createImageBitmap(blob,{resizeWidth:width,resizeHeight:height,resizeQuality:'high'});
      try{if(job.sceneToken!==this.sceneToken||this.desired.get(job.index)!==job.tier.name)return;job.tier.upload(job.index,bitmap,this.visibleSet)}finally{bitmap.close?.()}
      this.failedUntil.delete(job.key);this.requestDraw();
    }catch(error){this.failedUntil.set(job.key,Date.now()+5000);if(!String(error?.message||'').includes('404'))this.onError?.(error)}
  }

  originalTargetEdge(){return Math.min(ORIGINAL_MAX_EDGE,Math.max(ORIGINAL_MIN_EDGE,Math.ceil(this.screenItemSize()*(this.pixelRatio||1)*1.25)))}
  settleOriginals(visible,worldCenterX,worldCenterY){
    if(this.screenItemSize()<ORIGINAL_SCREEN_PX){this.originalDesired.clear();this.originalQueue.length=0;this.originalQueued.clear();return}
    const candidates=visible.filter(index=>this.media[index]?.type==='image').map(index=>{const o=index*4,dx=this.geometry[o]-worldCenterX,dy=this.geometry[o+1]-worldCenterY;return[index,dx*dx+dy*dy]}).sort((a,b)=>a[1]-b[1]).slice(0,ORIGINAL_MAX).map(entry=>entry[0]);
    this.originalDesired=new Set(candidates);const edge=this.originalTargetEdge();
    for(const index of candidates){const entry=this.originalEntries.get(index);if(entry&&entry.edge>=edge*.85){entry.lastUsed=performance.now();continue}if(this.originalQueued.has(index))continue;this.originalQueued.add(index);this.originalQueue.push({index,token:this.originalToken,edge})}
    this.evictOriginals();this.pumpOriginals();
  }
  evictOriginals(){while(this.originalEntries.size>ORIGINAL_MAX){let victim=null;for(const entry of this.originalEntries.values()){if(this.originalDesired.has(entry.index))continue;if(!victim||entry.lastUsed<victim.lastUsed)victim=entry}if(!victim)break;this.gl.deleteTexture(victim.texture);this.originalEntries.delete(victim.index)}}
  pumpOriginals(){while(this.originalLoads<ORIGINAL_CONCURRENCY&&this.originalQueue.length){const job=this.originalQueue.shift();this.originalQueued.delete(job.index);const entry=this.originalEntries.get(job.index);if(job.token!==this.originalToken||!this.originalDesired.has(job.index)||(entry&&entry.edge>=job.edge*.85))continue;this.originalLoads++;this.loadOriginal(job).finally(()=>{this.originalLoads--;this.pumpOriginals()})}}
  async loadOriginal(job){
    const item=this.media[job.index];if(!item||item.type!=='image')return;
    try{const response=await fetch(`/api/objects/${encodeURIComponent(item.hash)}`,{cache:'force-cache'});if(!response.ok)throw new Error(`Original ${response.status}`);const blob=await response.blob();if(job.token!==this.originalToken||!this.originalDesired.has(job.index))return;const edge=Math.min(ORIGINAL_MAX_EDGE,Math.max(ORIGINAL_MIN_EDGE,Number(job.edge)||this.originalTargetEdge())),[width,height]=bitmapSize(item,edge),bitmap=await createImageBitmap(blob,{resizeWidth:width,resizeHeight:height,resizeQuality:'high'});
      try{if(job.token!==this.originalToken||!this.originalDesired.has(job.index))return;const gl=this.gl,texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,bitmap);const previous=this.originalEntries.get(job.index);if(previous)this.gl.deleteTexture(previous.texture);this.originalEntries.set(job.index,{index:job.index,texture,lastUsed:performance.now(),edge});this.evictOriginals();this.requestDraw()}finally{bitmap.close?.()}
    }catch(error){if(!String(error?.message||'').includes('404'))this.onError?.(error)}
  }

  drawUnderlay(){}

  draw(){
    if(!this.gl||this.lost)return;const gl=this.gl;gl.viewport(0,0,this.canvas.width,this.canvas.height);gl.clearColor(.055,.051,.059,1);gl.clear(gl.COLOR_BUFFER_BIT);gl.useProgram(this.program);gl.uniform2f(this.uViewport,Math.max(1,this.canvas.clientWidth),Math.max(1,this.canvas.clientHeight));gl.uniform2f(this.uPan,this.panX,this.panY);gl.uniform1f(this.uZoom,this.zoom);
    this.drawInstances(this.placeholderBuffer,this.placeholderCount||0,this.placeholderTexture,0);this.drawUnderlay();const screenPx=this.screenItemSize();
    if(screenPx>=SMALL_SCREEN_PX){for(const page of this.tiers.small.pages){page.rebuildBuffer();this.drawInstances(page.buffer,page.count,page.texture,1)}if(screenPx>=DETAIL_SCREEN_PX)for(const page of this.tiers.detail.pages){page.rebuildBuffer();this.drawInstances(page.buffer,page.count,page.texture,1)}}
    if(screenPx>=ORIGINAL_SCREEN_PX&&this.originalDesired.size){for(const index of this.originalDesired){const entry=this.originalEntries.get(index);if(!entry||!this.valid[index])continue;const o=index*4,values=new Float32Array([this.geometry[o],this.geometry[o+1],this.geometry[o+2],this.geometry[o+3],0,0,1,1]);gl.bindBuffer(gl.ARRAY_BUFFER,this.originalBuffer);gl.bufferData(gl.ARRAY_BUFFER,values,gl.DYNAMIC_DRAW);this.drawInstances(this.originalBuffer,1,entry.texture,1);entry.lastUsed=performance.now()}}
    if(this.hoverIndex>=0&&this.valid[this.hoverIndex]){const o=this.hoverIndex*4,values=new Float32Array([this.geometry[o],this.geometry[o+1],this.geometry[o+2],this.geometry[o+3],0,0,1,1]);gl.bindBuffer(gl.ARRAY_BUFFER,this.hoverBuffer);gl.bufferData(gl.ARRAY_BUFFER,values,gl.DYNAMIC_DRAW);this.drawInstances(this.hoverBuffer,1,this.placeholderTexture,2)}
  }

  stats(){return{...super.stats(),smallEdge:SMALL_EDGE,detailEdge:FULL_THUMB_EDGE,concurrency:LOAD_CONCURRENCY,originals:this.originalEntries.size,originalQueued:this.originalQueue.length,originalLoading:this.originalLoads,originalAt:ORIGINAL_SCREEN_PX}}
}
