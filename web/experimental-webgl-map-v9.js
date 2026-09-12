import { ExperimentalWebGLMapRenderer as BaseRenderer } from './experimental-webgl-map-v8.js';

const LIVE_SETTLE_MS=45;
const PREFETCH_QUIET_MS=150;
const ORIGINAL_QUIET_MS=190;
const REFRESH_BATCH_MS=45;
const DETAIL_SCREEN_PX=48;
const MICRO_ONLY_SCREEN_PX=16;
const LOAD_CONCURRENCY=20;
const MOVING_DETAIL_CONCURRENCY=4;
const SETTLED_DETAIL_CONCURRENCY=8;
const ORIGINAL_CONCURRENCY=1;

export class ExperimentalWebGLMapRenderer extends BaseRenderer{
  constructor(canvas,options={}){
    super(canvas,options);
    this.lastCameraAt=0;
    this.lastLiveSettle=0;
    this.liveSettleTimer=0;
    this.quietSettleTimer=0;
    this.refreshTimer=0;
    this.pendingRefresh=new Map();
    this.hashIndex=new Map();
    this.detailWanted=new Set();
    this.activeDetailLoads=0;
  }

  destroy(){
    clearTimeout(this.liveSettleTimer);
    clearTimeout(this.quietSettleTimer);
    clearTimeout(this.refreshTimer);
    this.liveSettleTimer=0;
    this.quietSettleTimer=0;
    this.refreshTimer=0;
    this.pendingRefresh.clear();
    this.hashIndex.clear();
    this.detailWanted.clear();
    super.destroy();
  }

  setScene(scene){
    clearTimeout(this.liveSettleTimer);
    clearTimeout(this.quietSettleTimer);
    clearTimeout(this.refreshTimer);
    this.liveSettleTimer=0;
    this.quietSettleTimer=0;
    this.refreshTimer=0;
    this.pendingRefresh.clear();
    this.detailWanted.clear();
    super.setScene(scene);
    this.hashIndex=new Map(this.media.map((item,index)=>[String(item?.hash||''),index]));
  }

  clearMovingWork(){
    // Drop only work that has not started yet. Keep the current desired set alive
    // until the next live settle so in-flight thumbnails can actually finish while
    // the camera is moving instead of being invalidated by every wheel event.
    this.resetPendingThumbnailLoads();
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
    this.clearMovingWork();
    this.scheduleLiveSettle();
    this.scheduleQuietSettle();
    this.requestDraw();
  }

  scheduleLiveSettle(){
    const now=performance.now(),elapsed=now-this.lastLiveSettle;
    if(elapsed>=LIVE_SETTLE_MS){
      this.lastLiveSettle=now;
      this.settleNow();
      return;
    }
    if(this.liveSettleTimer)return;
    this.liveSettleTimer=setTimeout(()=>{
      this.liveSettleTimer=0;
      this.lastLiveSettle=performance.now();
      this.settleNow();
    },Math.max(0,LIVE_SETTLE_MS-elapsed));
  }

  scheduleQuietSettle(){
    clearTimeout(this.quietSettleTimer);
    const elapsed=performance.now()-this.lastCameraAt;
    const next=[PREFETCH_QUIET_MS,ORIGINAL_QUIET_MS].find(value=>value>elapsed+.5);
    if(next==null)return;
    this.quietSettleTimer=setTimeout(()=>{
      this.quietSettleTimer=0;
      this.settleNow();
      this.scheduleQuietSettle();
    },Math.max(0,next-elapsed));
  }

  nearestIndexes(indexes,limit,worldCenterX,worldCenterY){
    const ranked=indexes.map(index=>{
      const offset=index*4,dx=this.geometry[offset]-worldCenterX,dy=this.geometry[offset+1]-worldCenterY;
      return[index,dx*dx+dy*dy];
    }).sort((a,b)=>a[1]-b[1]);
    return(limit<ranked.length?ranked.slice(0,limit):ranked).map(entry=>entry[0]);
  }

  settleNow(){
    if(!this.result||this.lost)return;
    const screenPx=this.screenItemSize();
    if(screenPx<MICRO_ONLY_SCREEN_PX){
      this.detailWanted.clear();
      super.settle();
      return;
    }

    this.resetPendingThumbnailLoads();
    const elapsed=performance.now()-this.lastCameraAt;
    const allowDetail=screenPx>=DETAIL_SCREEN_PX;
    const allowPrefetch=elapsed>=PREFETCH_QUIET_MS;
    const allowOriginal=elapsed>=ORIGINAL_QUIET_MS;
    const visible=this.visibleIndexes(0);
    const nearby=allowPrefetch?this.visibleIndexes(this.prefetchOverscan(screenPx)):visible;
    this.visibleCount=visible.length;
    this.visibleSet=new Set(nearby);
    this.desired.clear();
    this.detailWanted.clear();

    if(!visible.length){
      this.originalDesired.clear();
      this.originalQueue.length=0;
      this.originalQueued.clear();
      this.requestDraw();
      return;
    }

    const worldCenterX=(this.canvas.clientWidth*.5-this.panX)/this.zoom;
    const worldCenterY=(this.canvas.clientHeight*.5-this.panY)/this.zoom;
    const small=this.tiers.small,detail=this.tiers.detail;
    const rankedVisible=this.nearestIndexes(visible,Math.min(small.capacity(),10000),worldCenterX,worldCenterY);
    const visibleSet=new Set(rankedVisible);

    // First queue every missing cheap thumbnail. Existing small thumbnails may
    // upgrade to detail even during continuous motion, so a slow zoom never has
    // to stop before the visible images sharpen.
    for(const index of rankedVisible){
      if(detail.get(index)){
        this.desired.set(index,detail.name);
        continue;
      }
      if(!small.get(index)){
        this.desired.set(index,small.name);
        this.enqueue(index,small);
        continue;
      }
      if(allowDetail){
        this.detailWanted.add(index);
        this.desired.set(index,detail.name);
      }else this.desired.set(index,small.name);
    }

    // Detail comes after the small pass so missing visible thumbnails always
    // have queue priority. Only a few detail decodes run at once while moving.
    if(allowDetail){
      for(const index of rankedVisible){
        if(!this.detailWanted.has(index)||detail.get(index))continue;
        this.enqueue(index,detail);
      }
    }

    // Speculative work still waits for a pause and stays on the cheap tier.
    if(allowPrefetch&&nearby.length>visibleSet.size){
      const remaining=Math.max(0,Math.min(small.capacity(),10000)-rankedVisible.length);
      const around=this.nearestIndexes(nearby.filter(index=>!visibleSet.has(index)),remaining,worldCenterX,worldCenterY);
      for(const index of around){
        if(small.get(index)||detail.get(index))continue;
        this.desired.set(index,small.name);
        this.enqueue(index,small);
      }
    }

    this.pump();
    if(allowOriginal)this.settleOriginals(rankedVisible,worldCenterX,worldCenterY);
    else{
      this.originalDesired.clear();
      this.originalQueue.length=0;
      this.originalQueued.clear();
    }
    this.requestDraw();
  }

  settle(){
    if(!this.result||this.lost)return;
    const elapsed=performance.now()-this.lastCameraAt;
    if(elapsed<LIVE_SETTLE_MS)this.scheduleLiveSettle();
    else this.settleNow();
    this.scheduleQuietSettle();
  }

  async load(job){
    await super.load(job);
    if(job.tier.name!=='small')return;
    if(job.sceneToken!==this.sceneToken||this.desired.get(job.index)!==job.tier.name)return;
    if(!this.visibleSet.has(job.index)||!this.tiers.small.get(job.index)||this.tiers.detail.get(job.index))return;
    if(this.screenItemSize()<DETAIL_SCREEN_PX)return;
    this.detailWanted.add(job.index);
    this.desired.set(job.index,this.tiers.detail.name);
    this.enqueue(job.index,this.tiers.detail);
    this.pump();
  }

  refreshThumbnail(hash,includeMicro=false){
    const index=this.hashIndex.get(String(hash||''));
    if(!Number.isInteger(index))return;
    this.pendingRefresh.set(index,Boolean(includeMicro)||Boolean(this.pendingRefresh.get(index)));
    clearTimeout(this.refreshTimer);
    this.refreshTimer=setTimeout(()=>this.flushThumbnailRefresh(),REFRESH_BATCH_MS);
  }

  flushThumbnailRefresh(){
    this.refreshTimer=0;
    if(!this.pendingRefresh.size)return;
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
    this.settleNow();
    this.requestDraw();
  }

  nextLoadJob(detailLimit){
    for(let index=0;index<this.queue.length;index++){
      const job=this.queue[index];
      if(job.tier.name==='detail'&&this.activeDetailLoads>=detailLimit)continue;
      this.queue.splice(index,1);
      this.queued.delete(job.key);
      return job;
    }
    return null;
  }

  pump(){
    const moving=performance.now()-this.lastCameraAt<PREFETCH_QUIET_MS;
    const detailLimit=moving?MOVING_DETAIL_CONCURRENCY:SETTLED_DETAIL_CONCURRENCY;
    while(this.activeLoads<LOAD_CONCURRENCY&&this.queue.length){
      const job=this.nextLoadJob(detailLimit);
      if(!job)break;
      if(job.sceneToken!==this.sceneToken||this.desired.get(job.index)!==job.tier.name||job.tier.entries.has(job.index))continue;
      const detail=job.tier.name==='detail';
      this.activeLoads++;
      if(detail)this.activeDetailLoads++;
      this.load(job).finally(()=>{
        this.activeLoads--;
        if(detail)this.activeDetailLoads--;
        this.pump();
      });
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
      detailConcurrency:performance.now()-this.lastCameraAt<PREFETCH_QUIET_MS?MOVING_DETAIL_CONCURRENCY:SETTLED_DETAIL_CONCURRENCY,
      activeDetailLoads:this.activeDetailLoads,
      originalConcurrency:ORIGINAL_CONCURRENCY,
      interactionDeferredLoading:false,
      livePanLoading:true,
      liveSettleMs:LIVE_SETTLE_MS,
      prefetchQuietMs:PREFETCH_QUIET_MS,
      originalQuietMs:ORIGINAL_QUIET_MS,
      pendingRefresh:this.pendingRefresh.size,
      viewportFirstLoading:true,
      continuousDetailLoading:true
    };
  }
}
