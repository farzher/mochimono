import { ExperimentalWebGLMapRenderer as BaseRenderer } from './experimental-webgl-map-v6.js';

const EXTREME_RATIO=4;

function mediaRatio(item){
  const width=Number(item?.width),height=Number(item?.height);
  return width>0&&height>0?width/height:0;
}

export class ExperimentalWebGLMapRenderer extends BaseRenderer{
  setScene(scene){
    super.setScene(scene);
    let changed=false;
    for(let index=0;index<this.media.length;index++){
      if(!this.valid[index])continue;
      const ratio=mediaRatio(this.media[index]);
      if(ratio>=EXTREME_RATIO||(ratio>0&&ratio<=1/EXTREME_RATIO)){
        if(!this.cropMask[index]){this.cropMask[index]=1;changed=true}
      }
    }
    if(changed){
      for(const tier of Object.values(this.tiers||{}))this.applyCropToTier(tier);
      this.requestDraw();
    }
  }

  stats(){return{...super.stats(),prepackedExtremeCrop:true}}
}
