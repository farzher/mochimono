import { ExperimentalWebGLMapRenderer as BaseRenderer } from './experimental-webgl-map-v7.js';

export class ExperimentalWebGLMapRenderer extends BaseRenderer{
  resetPendingViewportLoads(){
    this.queue.length=0;
    this.queued.clear();
    if(this.originalQueue){this.originalQueue.length=0;this.originalQueued?.clear()}
  }

  settle(){
    if(!this.result||this.lost)return;
    this.resetPendingViewportLoads();
    super.settle();
  }

  stats(){return{...super.stats(),viewportPriorityReset:true}}
}
