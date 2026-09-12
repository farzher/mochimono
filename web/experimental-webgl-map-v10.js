import { ExperimentalWebGLMapRenderer as BaseRenderer } from './experimental-webgl-map-v9.js';

const ORIGINAL_SCREEN_PX=220;
const ORIGINAL_QUIET_MS=190;
const MOVING_ORIGINAL_MAX=1;

export class ExperimentalWebGLMapRenderer extends BaseRenderer{
  clearMovingWork(){
    // Keep already-loaded close originals selected while the camera moves.
    // v9 intentionally clears pending thumbnail work here, but clearing
    // originalDesired makes a sharp image instantly fall back to the 512 px
    // thumbnail on every wheel tick.
    const desired=this.originalDesired?new Set(this.originalDesired):null;
    super.clearMovingWork();
    if(desired&&this.originalDesired){
      this.originalDesired.clear();
      for(const index of desired)this.originalDesired.add(index);
    }
  }

  settleNow(){
    super.settleNow();
    if(!this.result||this.lost)return;
    const screenPx=this.screenItemSize();
    const moving=performance.now()-this.lastCameraAt<ORIGINAL_QUIET_MS;
    if(!moving||screenPx<ORIGINAL_SCREEN_PX)return;

    // Even during a continuous zoom, keep upgrading the image nearest the
    // viewport center from thumbnail quality to an original-resolution texture.
    // Limit moving original work to one image so this does not reintroduce the
    // decode/upload bursts that caused interaction stutter.
    const visible=this.visibleIndexes(0).filter(index=>this.media[index]?.type==='image');
    if(!visible.length){
      this.originalDesired.clear();
      this.originalQueue.length=0;
      this.originalQueued.clear();
      return;
    }
    const worldCenterX=(this.canvas.clientWidth*.5-this.panX)/this.zoom;
    const worldCenterY=(this.canvas.clientHeight*.5-this.panY)/this.zoom;
    const closest=visible.map(index=>{
      const offset=index*4;
      const dx=this.geometry[offset]-worldCenterX,dy=this.geometry[offset+1]-worldCenterY;
      return[index,dx*dx+dy*dy];
    }).sort((a,b)=>a[1]-b[1]).slice(0,MOVING_ORIGINAL_MAX).map(entry=>entry[0]);
    this.settleOriginals(closest,worldCenterX,worldCenterY);
    this.requestDraw();
  }

  stats(){return{...super.stats(),continuousOriginalLoading:true,movingOriginalMax:MOVING_ORIGINAL_MAX}}
}
