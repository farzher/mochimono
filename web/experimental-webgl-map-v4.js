import { ExperimentalWebGLMapRenderer as BaseRenderer } from './experimental-webgl-map-v3.js';

const DETAIL_SCREEN_PX=48;
const MICRO_ONLY_SCREEN_PX=16;
const LIVE_SETTLE_MS=72;
const MID_PREFETCH_PX=240;
const DETAIL_PREFETCH_PX=360;

export class ExperimentalWebGLMapRenderer extends BaseRenderer{
  constructor(canvas,options={}){
    super(canvas,options);
    this.liveSettleTimer=0;
    this.lastLiveSettle=0;
  }

  destroy(){
    clearTimeout(this.liveSettleTimer);
    this.liveSettleTimer=0;
    super.destroy();
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

  prefetchOverscan(screenPx){
    const margin=screenPx>=DETAIL_SCREEN_PX?DETAIL_PREFETCH_PX:MID_PREFETCH_PX;
    const screenCell=Math.max(1,this.cell*this.zoom);
    return Math.max(2,Math.min(10,Math.ceil(margin/screenCell)+1));
  }

  settle(){
    if(!this.result||this.lost)return;
    const screenPx=this.screenItemSize();
    if(screenPx<MICRO_ONLY_SCREEN_PX)return super.settle();

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

  stats(){
    return{...super.stats(),livePanLoading:true,liveSettleMs:LIVE_SETTLE_MS,midPrefetchPx:MID_PREFETCH_PX,detailPrefetchPx:DETAIL_PREFETCH_PX};
  }
}
