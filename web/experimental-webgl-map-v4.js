import { ensureBrowserThumbnail, isHeicRecord } from './browser-thumbnail-fallback.js';
import { ExperimentalWebGLMapRenderer as BaseRenderer } from './experimental-webgl-map-v3.js';

const DETAIL_SCREEN_PX=48;
const MICRO_ONLY_SCREEN_PX=16;
const LIVE_SETTLE_MS=72;
const MID_PREFETCH_PX=240;
const DETAIL_PREFETCH_PX=360;
const HEIC_FAR_LIMIT=6000;
const heicRecord=item=>item?.type==='image'&&isHeicRecord({filename:item.filename,mime:item.mime})
  ?{hash:item.hash,filename:item.filename,mime:item.mime||'image/heic',kind:'image',urgent:true}:null;

export class ExperimentalWebGLMapRenderer extends BaseRenderer{
  constructor(canvas,options={}){
    super(canvas,{...options,thumbVersion:Math.max(4,Number(options.thumbVersion)||0)});
    this.liveSettleTimer=0;
    this.lastLiveSettle=0;
    this.onHeicRepaired=event=>this.refreshHeic(String(event.detail?.hash||''));
    window.addEventListener('mochimono:heic-repaired',this.onHeicRepaired);
  }

  destroy(){
    clearTimeout(this.liveSettleTimer);
    this.liveSettleTimer=0;
    window.removeEventListener('mochimono:heic-repaired',this.onHeicRepaired);
    super.destroy();
  }

  refreshHeic(hash){
    const index=this.media.findIndex(item=>item?.hash===hash);
    if(index<0)return;
    for(const tier of Object.values(this.tiers||{})){
      const entry=tier?.entries?.get(index);
      if(!entry)continue;
      tier.entries.delete(index);
      entry.page?.release?.(entry);
    }
    for(const key of [...this.failedUntil.keys()])if(key.endsWith(`:${index}`))this.failedUntil.delete(key);
    this.settle();
    this.requestDraw();
  }

  setCamera(panX,panY,zoom){
    super.setCamera(panX,panY,zoom);
    if(!this.result||this.lost)return;
    const now=performance.now(),elapsed=now-this.lastLiveSettle;
    if(elapsed>=LIVE_SETTLE_MS){
      this.lastLiveSettle=now;
      this.settle();
      return;
    }
    if(this.liveSettleTimer)return;
    this.liveSettleTimer=setTimeout(()=>{
      this.liveSettleTimer=0;
      this.lastLiveSettle=performance.now();
      this.settle();
    },Math.max(0,LIVE_SETTLE_MS-elapsed));
  }

  async load(job){
    const item=this.media[job.index],record=heicRecord(item);
    if(record)await ensureBrowserThumbnail(record).catch(()=>{});
    return super.load(job);
  }

  prefetchOverscan(screenPx){
    const margin=screenPx>=DETAIL_SCREEN_PX?DETAIL_PREFETCH_PX:MID_PREFETCH_PX;
    const screenCell=Math.max(1,this.cell*this.zoom);
    return Math.max(2,Math.min(10,Math.ceil(margin/screenCell)+1));
  }

  settleFarHeic(){
    super.settle();
    const indexes=[...this.visibleSet].filter(index=>heicRecord(this.media[index])).slice(0,HEIC_FAR_LIMIT);
    if(!indexes.length)return;
    const small=this.tiers.small;
    for(const index of indexes){
      this.desired.set(index,small.name);
      if(!small.get(index))this.enqueue(index,small);
    }
    this.pump();
    this.requestDraw();
  }

  settle(){
    if(!this.result||this.lost)return;
    const screenPx=this.screenItemSize();
    if(screenPx<MICRO_ONLY_SCREEN_PX)return this.settleFarHeic();

    const nearby=this.visibleIndexes(this.prefetchOverscan(screenPx));
    this.visibleCount=nearby.length;
    this.visibleSet=new Set(nearby);
    this.desired.clear();
    if(!nearby.length){
      this.queue.length=0;
      this.queued.clear();
      this.originalDesired.clear();
      this.requestDraw();
      return;
    }

    const worldCenterX=(this.canvas.clientWidth*.5-this.panX)/this.zoom;
    const worldCenterY=(this.canvas.clientHeight*.5-this.panY)/this.zoom;
    const ranked=nearby.map(index=>{
      const offset=index*4,dx=this.geometry[offset]-worldCenterX,dy=this.geometry[offset+1]-worldCenterY;
      return[index,dx*dx+dy*dy];
    }).sort((a,b)=>a[1]-b[1]).map(entry=>entry[0]);

    const small=this.tiers.small;
    const smallWanted=ranked.slice(0,Math.min(small.capacity(),10000));
    if(screenPx>=DETAIL_SCREEN_PX){
      const detail=this.tiers.detail;
      const detailSet=new Set(ranked.slice(0,Math.min(detail.capacity(),ranked.length)));
      for(const index of smallWanted){
        const tier=detailSet.has(index)?detail:small;
        this.desired.set(index,tier.name);
        if(!tier.get(index))this.enqueue(index,tier);
      }
    }else{
      for(const index of smallWanted){
        this.desired.set(index,small.name);
        if(!small.get(index))this.enqueue(index,small);
      }
    }

    this.pump();
    this.settleOriginals(nearby,worldCenterX,worldCenterY);
    this.requestDraw();
  }

  drawMicroOnly(){
    super.drawMicroOnly();
    const gl=this.gl;
    if(!gl||this.lost)return;
    gl.useProgram(this.program);
    gl.uniform2f(this.uViewport,Math.max(1,this.canvas.clientWidth),Math.max(1,this.canvas.clientHeight));
    gl.uniform2f(this.uPan,this.panX,this.panY);
    gl.uniform1f(this.uZoom,this.zoom);
    for(const page of this.tiers.small.pages){
      page.rebuildBuffer();
      this.drawInstances(page.buffer,page.count,page.texture,1);
    }
    if(this.hoverIndex>=0&&this.valid[this.hoverIndex]){
      const o=this.hoverIndex*4,values=new Float32Array([this.geometry[o],this.geometry[o+1],this.geometry[o+2],this.geometry[o+3],0,0,1,1]);
      gl.bindBuffer(gl.ARRAY_BUFFER,this.hoverBuffer);
      gl.bufferData(gl.ARRAY_BUFFER,values,gl.DYNAMIC_DRAW);
      this.drawInstances(this.hoverBuffer,1,this.placeholderTexture,2);
    }
  }

  stats(){
    return{...super.stats(),livePanLoading:true,liveSettleMs:LIVE_SETTLE_MS,midPrefetchPx:MID_PREFETCH_PX,detailPrefetchPx:DETAIL_PREFETCH_PX,heicFarOverlay:true};
  }
}
