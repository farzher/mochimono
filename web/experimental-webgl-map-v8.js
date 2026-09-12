import { ExperimentalWebGLMapRenderer as BaseRenderer } from './experimental-webgl-map-v7.js';

export class ExperimentalWebGLMapRenderer extends BaseRenderer{
  resetPendingThumbnailLoads(){
    this.queue.length=0;
    this.queued.clear();
  }

  settle(){
    if(!this.result||this.lost)return;
    this.resetPendingThumbnailLoads();
    super.settle();
  }

  stats(){return{...super.stats(),viewportPriorityReset:true}}
}
