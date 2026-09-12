import { ExperimentalWebGLMapRenderer as BaseRenderer } from './experimental-webgl-map-v5.js';

const EXTREME_RATIO=4;
const DISPLAY_MAX_RATIO=2;
const DISPLAY_MIN_RATIO=1/DISPLAY_MAX_RATIO;

function mediaRatio(item){
  const width=Number(item?.width),height=Number(item?.height);
  return width>0&&height>0?width/height:0;
}

export class ExperimentalWebGLMapRenderer extends BaseRenderer{
  constructor(canvas,options={}){
    super(canvas,options);
    this.cropMask=new Uint8Array(0);
  }

  setScene(scene){
    super.setScene(scene);
    const count=this.media.length;
    this.cropMask=new Uint8Array(count);
    this.maxGeometryHalfCells=0;

    for(let index=0;index<count;index++){
      if(!this.valid[index])continue;
      const ratio=mediaRatio(this.media[index]),offset=index*4;
      let width=this.geometry[offset+2],height=this.geometry[offset+3];
      if(ratio>=EXTREME_RATIO&&width/Math.max(.0001,height)>DISPLAY_MAX_RATIO){
        height=width/DISPLAY_MAX_RATIO;
        this.cropMask[index]=1;
      }else if(ratio>0&&ratio<=1/EXTREME_RATIO&&width/Math.max(.0001,height)<DISPLAY_MIN_RATIO){
        width=height*DISPLAY_MIN_RATIO;
        this.cropMask[index]=1;
      }
      this.geometry[offset+2]=width;
      this.geometry[offset+3]=height;
      this.maxGeometryHalfCells=Math.max(this.maxGeometryHalfCells,width/this.cell*.5,height/this.cell*.5);
    }

    this.rebuildPlaceholderGeometry();
    for(const tier of Object.values(this.tiers||{}))this.applyCropToTier(tier);
    this.requestDraw();
  }

  rebuildPlaceholderGeometry(){
    const instances=new Float32Array(this.media.length*8);
    let count=0;
    for(let index=0;index<this.media.length;index++){
      if(!this.valid[index])continue;
      const offset=index*4,at=count*8;
      instances[at]=this.geometry[offset];
      instances[at+1]=this.geometry[offset+1];
      instances[at+2]=this.geometry[offset+2];
      instances[at+3]=this.geometry[offset+3];
      instances[at+4]=0;
      instances[at+5]=0;
      instances[at+6]=1;
      instances[at+7]=1;
      count++;
    }
    this.placeholderCount=count;
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER,this.placeholderBuffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER,instances.subarray(0,count*8),this.gl.STATIC_DRAW);
  }

  croppedUv(index,base){
    if(!this.cropMask?.[index])return base.slice();
    const ratio=mediaRatio(this.media[index]),offset=index*4;
    const displayRatio=this.geometry[offset+2]/Math.max(.0001,this.geometry[offset+3]);
    let[u0,v0,u1,v1]=base;
    if(ratio>displayRatio){
      const fraction=Math.max(.001,Math.min(1,displayRatio/ratio));
      const center=(u0+u1)*.5,half=(u1-u0)*fraction*.5;
      u0=center-half;u1=center+half;
    }else if(ratio>0&&ratio<displayRatio){
      const fraction=Math.max(.001,Math.min(1,ratio/displayRatio));
      const center=(v0+v1)*.5,half=(v1-v0)*fraction*.5;
      v0=center-half;v1=center+half;
    }
    return[u0,v0,u1,v1];
  }

  applyCropEntry(index,entry){
    if(!entry)return;
    if(!entry.baseUv)entry.baseUv=entry.uv.slice();
    entry.uv=this.croppedUv(index,entry.baseUv);
    if(entry.page)entry.page.dirty=true;
  }

  applyCropToTier(tier){
    if(!tier?.entries)return;
    for(const[index,entry]of tier.entries)this.applyCropEntry(index,entry);
  }

  async load(job){
    await super.load(job);
    this.applyCropEntry(job.index,job.tier?.entries?.get(job.index));
    this.requestDraw();
  }

  installOverview(pixels,available,edge){
    super.installOverview(pixels,available,edge);
    this.applyCropToTier(this.tiers?.micro);
    this.requestDraw();
  }

  draw(){
    super.draw();
    if(this.screenItemSize()<220||!this.originalDesired?.size)return;
    const gl=this.gl;
    if(!gl||this.lost)return;
    gl.useProgram(this.program);
    gl.uniform2f(this.uViewport,Math.max(1,this.canvas.clientWidth),Math.max(1,this.canvas.clientHeight));
    gl.uniform2f(this.uPan,this.panX,this.panY);
    gl.uniform1f(this.uZoom,this.zoom);

    let redrewOriginal=false;
    for(const index of this.originalDesired){
      if(!this.cropMask[index]||!this.valid[index])continue;
      const entry=this.originalEntries.get(index);
      if(!entry)continue;
      const offset=index*4,uv=this.croppedUv(index,[0,0,1,1]);
      const values=new Float32Array([
        this.geometry[offset],this.geometry[offset+1],this.geometry[offset+2],this.geometry[offset+3],
        uv[0],uv[1],uv[2],uv[3]
      ]);
      gl.bindBuffer(gl.ARRAY_BUFFER,this.originalBuffer);
      gl.bufferData(gl.ARRAY_BUFFER,values,gl.DYNAMIC_DRAW);
      this.drawInstances(this.originalBuffer,1,entry.texture,1);
      entry.lastUsed=performance.now();
      redrewOriginal=true;
    }

    if(redrewOriginal&&this.hoverIndex>=0&&this.cropMask[this.hoverIndex]&&this.valid[this.hoverIndex]){
      const offset=this.hoverIndex*4,values=new Float32Array([
        this.geometry[offset],this.geometry[offset+1],this.geometry[offset+2],this.geometry[offset+3],0,0,1,1
      ]);
      gl.bindBuffer(gl.ARRAY_BUFFER,this.hoverBuffer);
      gl.bufferData(gl.ARRAY_BUFFER,values,gl.DYNAMIC_DRAW);
      this.drawInstances(this.hoverBuffer,1,this.placeholderTexture,2);
    }
  }

  stats(){
    let cropped=0;
    for(const value of this.cropMask||[])cropped+=value?1:0;
    return{...super.stats(),extremeAspectCrop:true,extremeAspectAt:EXTREME_RATIO,extremeAspectDisplayMax:DISPLAY_MAX_RATIO,cropped};
  }
}
