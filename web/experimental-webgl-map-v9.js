import { ExperimentalWebGLMapRenderer as BaseRenderer } from './experimental-webgl-map-v8.js';

const LOAD_CONCURRENCY=4;
const ORIGINAL_CONCURRENCY=1;

export class ExperimentalWebGLMapRenderer extends BaseRenderer{
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
    this.invalidateMovingLoads();
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
      livePanLoading:false
    };
  }
}
