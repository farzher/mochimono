import { ExperimentalWebGLMapRenderer as BaseRenderer } from './experimental-webgl-map-v9.js';

const ORIGINAL_SCREEN_PX=220;
const ORIGINAL_QUIET_MS=190;
const MOVING_ORIGINAL_MAX=1;
const MOVING_ORIGINAL_SCAN=12;

export class ExperimentalWebGLMapRenderer extends BaseRenderer{
  settleMovingOriginal(){
    if(!this.result||this.lost||this.screenItemSize()<ORIGINAL_SCREEN_PX)return;
    if(performance.now()-this.lastCameraAt>=ORIGINAL_QUIET_MS)return;
    const closest=this.priorityVisibleIndexes(MOVING_ORIGINAL_SCAN,0)
      .filter(index=>this.media[index]?.type==='image')
      .slice(0,MOVING_ORIGINAL_MAX);
    if(!closest.length)return;
    const worldCenterX=(this.canvas.clientWidth*.5-this.panX)/this.zoom;
    const worldCenterY=(this.canvas.clientHeight*.5-this.panY)/this.zoom;
    this.settleOriginals(closest,worldCenterX,worldCenterY);
    this.requestDraw();
  }

  settleLive(){
    super.settleLive();
    this.settleMovingOriginal();
  }

  settleNow(){
    super.settleNow();
    this.settleMovingOriginal();
  }

  stats(){return{...super.stats(),continuousOriginalLoading:true,movingOriginalMax:MOVING_ORIGINAL_MAX}}
}
