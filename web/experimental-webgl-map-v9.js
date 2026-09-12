import { ExperimentalWebGLMapRenderer as BaseRenderer } from './experimental-webgl-map-v8.js';

const LOAD_CONCURRENCY=4;
const ORIGINAL_CONCURRENCY=1;
const SETTLE_QUIET_MS=240;
const REFRESH_QUIET_MS=260;
const DETAIL_SCREEN_PX=48;
const MICRO_ONLY_SCREEN_PX=16;

export class ExperimentalWebGLMapRenderer extends BaseRenderer{
  constructor(canvas,options={}){
    super(canvas,options);
    this.lastCameraAt=0;
    this.settleTimer=0;
    this.refreshTimer=0;
    this.pendingRefresh=new Map();
    this.hashIndex=new Map();
  }

  destroy(){
    clearTimeout(this.settleTimer);
    clearTimeout(this.refreshTimer);
    this.settleTimer=0;
    this.refreshTimer=0;
    this.pendingRefresh.clear();
    this.hashIndex.clear();
    super.destroy();
  }

  setScene(scene){
    clearTimeout(this.settleTimer);
    clearTimeout(this.refreshTimer);
    this.settleTimer=0;
    this.refreshTimer=0;
    this.pendingRefresh.clear();
    super.setScene(scene);
    this.hashIndex=new Map(this.media.map((item,index)=>[String(item?.hash||''),index]));
  }

  invalidateMovingLoads(){
    if(this.queue.length)this.queue.length=0;
    if(this.queued.size)this.queued.clear();
    if(this.desired.size)this.desired.clear();
    if(this.originalQueue?.length)this.originalQueue.length=0;
    if(this.originalQueued?.size)this.originalQueued.clear();
    if(this.originalDesired?.size)this.originalDesired.clear();
  }

  setCamera(panX,panY,zoom){
    const nextX=Number(panX)||0,nextY=Number(panY)||0,nextZoom=Math.max(.0001,Number(zoom)||1);
    if(nextX===this.panX&&nextY===this.panY&&nextZoom===this.zoom)return;
    this.panX=nextX;
    this.panY=nextY;
    this.zoom=nextZoom;
    this.lastCameraAt=performance.now();
    this.invalidateMovingLoads();
    this.requestDraw();
  }

  nearestIndexes(indexes,limit,worldCenterX,worldCenterY){
    if(indexes.length<=limit)return indexes;
    return indexes.map(index=>{
      const offset=index*4,dx=this.geometry[offset]-worldCenterX,dy=this.geometry[offset+1]-worldCenterY;
      return[index,dx*dx+dy*dy];
    }).sort((a,b)=>a[1]-b[1]).slice(0,limit).map(entry=>entry[0]);
  }

  settleNow(){
    if(!this.result||this.lost)return;
    const screenPx=this.screenItemSize();
    if(screenPx<MICRO_ONLY_SCREEN_PX){super.settle();return}

    this.resetPendingThumbnailLoads();
    const nearby=this.visibleIndexes(this.prefetchOverscan(screenPx));
    this.visibleCount=nearby.length;
    this.visibleSet=new Set(nearby);
    this.desired.clear();
    if(!nearby.length){
      this.originalDesired.clear();
      this.requestDraw();
      return;
    }

    const worldCenterX=(this.canvas.clientWidth*.5-this.panX)/this.zoom;
    const worldCenterY=(this.canvas.clientHeight*.5-this.panY)/this.zoom;
    const small=this.tiers.small;
    const smallLimit=Math.min(small.capacity(),10000);
    const smallWanted=this.nearestIndexes(nearby,smallLimit,worldCenterX,worldCenterY);

    if(screenPx>=DETAIL_SCREEN_PX){
      const detail=this.tiers.detail;
      const detailWanted=this.nearestIndexes(nearby,Math.min(detail.capacity(),nearby.length),worldCenterX,worldCenterY);
      const detailSet=new Set(detailWanted);
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

  settle(){
    if(!this.result||this.lost)return;
    clearTimeout(this.settleTimer);
    const elapsed=performance.now()-this.lastCameraAt;
    if(elapsed<SETTLE_QUIET_MS){
      this.settleTimer=setTimeout(()=>{
        this.settleTimer=0;
        this.settleNow();
      },SETTLE_QUIET_MS-elapsed);
      return;
    }
    this.settleNow();
  }

  refreshThumbnail(hash,includeMicro=false){
    const index=this.hashIndex.get(String(hash||''));
    if(!Number.isInteger(index))return;
    this.pendingRefresh.set(index,Boolean(includeMicro)||Boolean(this.pendingRefresh.get(index)));
    this.scheduleThumbnailRefresh();
  }

  scheduleThumbnailRefresh(){
    clearTimeout(this.refreshTimer);
    const elapsed=performance.now()-this.lastCameraAt;
    const delay=Math.max(0,REFRESH_QUIET_MS-elapsed);
    this.refreshTimer=setTimeout(()=>this.flushThumbnailRefresh(),delay);
  }

  flushThumbnailRefresh(){
    this.refreshTimer=0;
    if(!this.pendingRefresh.size)return;
    if(performance.now()-this.lastCameraAt<REFRESH_QUIET_MS){this.scheduleThumbnailRefresh();return}
    for(const[index,includeMicro]of this.pendingRefresh){
      for(const[name,tier]of Object.entries(this.tiers||{})){
        if(!includeMicro&&name==='micro')continue;
        const entry=tier?.entries?.get(index);
        if(!entry)continue;
        tier.entries.delete(index);
        entry.page?.release?.(entry);
      }
      for(const key of [...this.failedUntil.keys()])if(key.endsWith(`:${index}`))this.failedUntil.delete(key);
      const original=this.originalEntries?.get(index);
      if(original){this.gl.deleteTexture(original.texture);this.originalEntries.delete(index)}
    }
    this.pendingRefresh.clear();
    this.settle();
    this.requestDraw();
  }

  pump(){
    while(this.activeLoads<LOAD_CONCURRENCY&&this.queue.length){
      const job=this.queue.shift();
      this.queued.delete(job.key);
      if(job.sceneToken!==this.sceneToken||this.desired.get(job.index)!==job.tier.name||job.tier.entries.has(job.index))continue;
      this.activeLoads++;
      this.load(job).finally(()=>{this.activeLoads--;this.pump()});
    }
  }

  pumpOriginals(){
    while(this.originalLoads<ORIGINAL_CONCURRENCY&&this.originalQueue.length){
      const job=this.originalQueue.shift();
      this.originalQueued.delete(job.index);
      const entry=this.originalEntries.get(job.index);
      if(job.token!==this.originalToken||!this.originalDesired.has(job.index)||(entry&&entry.edge>=job.edge*.85))continue;
      this.originalLoads++;
      this.loadOriginal(job).finally(()=>{this.originalLoads--;this.pumpOriginals()});
    }
  }

  stats(){
    return{
      ...super.stats(),
      concurrency:LOAD_CONCURRENCY,
      originalConcurrency:ORIGINAL_CONCURRENCY,
      interactionDeferredLoading:true,
      livePanLoading:false,
      settleQuietMs:SETTLE_QUIET_MS,
      refreshQuietMs:REFRESH_QUIET_MS,
      pendingRefresh:this.pendingRefresh.size
    };
  }
}
