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
const LIVE_VISIBLE_LIMIT=320;
const SETTLED_VISIBLE_LIMIT=4096;
const PREFETCH_EXTRA=256;

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
    this.resetPendingThumbnailLoads();
    if(this.originalQueue?.length)this.originalQueue.length=0;
    if(this.originalQueued?.size)this.originalQueued.clear();
  }

  setCamera(panX,panY,zoom){
    const nextX=Number(panX)||0,nextY=Number(panY)||0,nextZoom=Math.max(.0001,Number(zoom)||1);
    if(nextX===this.panX&&nextY===this.panY&&nextZoom===this.zoom)return;
    this.panX=nextX;
    this.panY=nextY;
    this.zoom=nextZoom;
    this.lastCameraAt=performance.now();
    this.requestDraw();
    this.scheduleLiveSettle();
    this.scheduleQuietSettle();
  }

  scheduleLiveSettle(){
    if(this.liveSettleTimer)return;
    const elapsed=performance.now()-this.lastLiveSettle;
    this.liveSettleTimer=setTimeout(()=>{
      this.liveSettleTimer=0;
      this.lastLiveSettle=performance.now();
      this.settleLive();
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

  visibleTarget(screenPx){
    const area=Math.max(1,this.canvas.clientWidth*this.canvas.clientHeight);
    const estimated=Math.ceil(area/Math.max(1,screenPx*screenPx)*1.35);
    return Math.max(LIVE_VISIBLE_LIMIT,Math.min(SETTLED_VISIBLE_LIMIT,estimated));
  }

  priorityVisibleIndexes(limit,overscanCells=0){
    if(!this.result||!this.spatial||limit<=0)return[];
    const zoom=Math.max(.0001,this.zoom),cell=Math.max(1,this.cell);
    const margin=Math.max(0,Number(overscanCells)||0)+(this.maxGeometryHalfCells||0);
    const left=(-this.panX)/zoom/cell-margin;
    const top=(-this.panY)/zoom/cell-margin;
    const right=(this.canvas.clientWidth-this.panX)/zoom/cell+margin;
    const bottom=(this.canvas.clientHeight-this.panY)/zoom/cell+margin;
    const bucket=Math.max(1,this.spatial.bucket||8);
    const minBx=Math.floor(left/bucket),maxBx=Math.floor(right/bucket);
    const minBy=Math.floor(top/bucket),maxBy=Math.floor(bottom/bucket);
    const centerCellX=((this.canvas.clientWidth*.5-this.panX)/zoom)/cell-.5;
    const centerCellY=((this.canvas.clientHeight*.5-this.panY)/zoom)/cell-.5;
    const centerBx=Math.max(minBx,Math.min(maxBx,Math.floor(centerCellX/bucket)));
    const centerBy=Math.max(minBy,Math.min(maxBy,Math.floor(centerCellY/bucket)));
    const worldCenterX=(this.canvas.clientWidth*.5-this.panX)/zoom;
    const worldCenterY=(this.canvas.clientHeight*.5-this.panY)/zoom;
    const ranked=[];
    const maxRing=Math.max(centerBx-minBx,maxBx-centerBx,centerBy-minBy,maxBy-centerBy);
    const visit=(bx,by)=>{
      if(bx<minBx||bx>maxBx||by<minBy||by>maxBy)return;
      for(const index of this.spatial.get(`${bx}:${by}`)||[]){
        const x=Number(this.result.x[index]),y=Number(this.result.y[index]);
        if(x<left||x>right||y<top||y>bottom)continue;
        ranked.push(index);
      }
    };
    for(let ring=0;ring<=maxRing;ring++){
      if(ring===0)visit(centerBx,centerBy);
      else{
        const x0=centerBx-ring,x1=centerBx+ring,y0=centerBy-ring,y1=centerBy+ring;
        for(let bx=x0;bx<=x1;bx++){visit(bx,y0);visit(bx,y1)}
        for(let by=y0+1;by<y1;by++){visit(x0,by);visit(x1,by)}
      }
      if(ranked.length>=limit)break;
    }
    ranked.sort((a,b)=>{
      let offset=a*4,dx=this.geometry[offset]-worldCenterX,dy=this.geometry[offset+1]-worldCenterY;
      const leftDistance=dx*dx+dy*dy;
      offset=b*4;dx=this.geometry[offset]-worldCenterX;dy=this.geometry[offset+1]-worldCenterY;
      return leftDistance-(dx*dx+dy*dy);
    });
    if(ranked.length>limit)ranked.length=limit;
    return ranked;
  }

  queueVisible(indexes,allowDetail){
    const small=this.tiers.small,detail=this.tiers.detail;
    for(const index of indexes){
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
    if(!allowDetail)return;
    for(const index of indexes){
      if(!this.detailWanted.has(index)||detail.get(index))continue;
      this.enqueue(index,detail);
    }
  }

  settleLive(){
    if(!this.result||this.lost)return;
    const screenPx=this.screenItemSize();
    if(screenPx<MICRO_ONLY_SCREEN_PX){this.requestDraw();return}
    this.resetPendingThumbnailLoads();
    this.desired.clear();
    this.detailWanted.clear();
    const visible=this.priorityVisibleIndexes(LIVE_VISIBLE_LIMIT,0);
    this.visibleCount=visible.length;
    this.visibleSet=new Set(visible);
    if(!visible.length){this.requestDraw();return}
    this.queueVisible(visible,screenPx>=DETAIL_SCREEN_PX);
    this.pump();
    this.requestDraw();
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
    const allowPrefetch=elapsed>=PREFETCH_QUIET_MS;
    const allowOriginal=elapsed>=ORIGINAL_QUIET_MS;
    const visibleLimit=this.visibleTarget(screenPx);
    const visible=this.priorityVisibleIndexes(visibleLimit,0);
    const nearby=allowPrefetch
      ?this.priorityVisibleIndexes(Math.min(SETTLED_VISIBLE_LIMIT,visibleLimit+PREFETCH_EXTRA),this.prefetchOverscan(screenPx))
      :visible;
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

    this.queueVisible(visible,screenPx>=DETAIL_SCREEN_PX);
    if(allowPrefetch&&nearby.length>visible.length){
      const visibleSet=new Set(visible),small=this.tiers.small,detail=this.tiers.detail;
      for(const index of nearby){
        if(visibleSet.has(index)||small.get(index)||detail.get(index))continue;
        this.desired.set(index,small.name);
        this.enqueue(index,small);
      }
    }

    this.pump();
    const worldCenterX=(this.canvas.clientWidth*.5-this.panX)/this.zoom;
    const worldCenterY=(this.canvas.clientHeight*.5-this.panY)/this.zoom;
    if(allowOriginal)this.settleOriginals(visible,worldCenterX,worldCenterY);
    else{
      this.originalQueue.length=0;
      this.originalQueued.clear();
    }
    this.requestDraw();
  }

  settle(){
    if(!this.result||this.lost)return;
    const elapsed=performance.now()-this.lastCameraAt;
    if(elapsed<PREFETCH_QUIET_MS)this.settleLive();
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
        if(entry){tier.entries.delete(index);entry.page?.release?.(entry)}
        this.failedUntil.delete(`${name}:${index}`);
      }
      const original=this.originalEntries?.get(index);
      if(original){this.gl.deleteTexture(original.texture);this.originalEntries.delete(index)}
    }
    this.pendingRefresh.clear();
    if(performance.now()-this.lastCameraAt<PREFETCH_QUIET_MS)this.settleLive();
    else this.settleNow();
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
      liveVisibleLimit:LIVE_VISIBLE_LIMIT,
      settledVisibleLimit:SETTLED_VISIBLE_LIMIT,
      prefetchQuietMs:PREFETCH_QUIET_MS,
      originalQuietMs:ORIGINAL_QUIET_MS,
      pendingRefresh:this.pendingRefresh.size,
      viewportFirstLoading:true,
      continuousDetailLoading:true,
      boundedLiveSelection:true
    };
  }
}
