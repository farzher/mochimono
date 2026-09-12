import { ExperimentalWebGLMapRenderer as BaseRenderer } from './experimental-webgl-map-v2.js';

const ATLAS_SIZE=2048;
const MICRO_EDGE=8;
const MICRO_PAGES=4;
const MICRO_ONLY_SCREEN_PX=16;
const ORIGINAL_SCREEN_PX=220;
const OVERVIEW_WORKER_REV='20260912-2';

function sameMediaOrder(current,next){
  if(!Array.isArray(current)||!Array.isArray(next)||current.length!==next.length)return false;
  for(let index=0;index<next.length;index++)if(String(current[index]?.hash||'')!==String(next[index]?.hash||''))return false;
  return true;
}

export class ExperimentalWebGLMapRenderer extends BaseRenderer{
  constructor(canvas,options={}){
    super(canvas,options);
    this.overviewWorker=null;
    this.overviewToken=0;
    this.overviewFound=0;
    this.overviewReady=false;
    this.configureTiers();
  }

  configureTiers(){
    super.configureTiers();
    if(!this.tiers?.micro&&this.tiers?.small){
      const Tier=this.tiers.small.constructor;
      this.tiers.micro=new Tier(this,'micro',MICRO_EDGE,MICRO_PAGES);
    }
    if(this.tiers?.micro){this.tiers.micro.edge=MICRO_EDGE;this.tiers.micro.maxPages=MICRO_PAGES}
  }

  stopOverview(){
    this.overviewToken++;
    if(this.overviewWorker){try{this.overviewWorker.postMessage({action:'cancel'})}catch{}try{this.overviewWorker.terminate()}catch{}this.overviewWorker=null}
  }

  setScene(scene){
    const nextMedia=Array.isArray(scene?.media)?scene.media:[],sameMedia=sameMediaOrder(this.media,nextMedia),hadOverview=Boolean(this.tiers?.micro?.entries?.size);
    if(!sameMedia)this.stopOverview();
    super.setScene(scene);
    this.configureTiers();
    if(!sameMedia||(!hadOverview&&!this.overviewWorker)){
      this.overviewFound=0;
      this.overviewReady=false;
      this.startOverview();
    }
  }

  destroy(){this.stopOverview();super.destroy()}

  startOverview(){
    if(!this.media.length||!this.tiers?.micro)return;
    const token=++this.overviewToken;
    const worker=new Worker(new URL(`./experimental-overview-worker.js?v=${OVERVIEW_WORKER_REV}`,import.meta.url),{type:'module'});
    this.overviewWorker=worker;
    worker.onerror=()=>{if(token===this.overviewToken){this.overviewWorker=null;this.overviewReady=true;this.requestDraw()}};
    worker.onmessage=event=>{
      if(token!==this.overviewToken)return;
      const data=event.data||{};
      if(data.type==='result'){
        this.overviewWorker=null;
        worker.terminate();
        this.installOverview(data.pixels,data.available,Number(data.edge)||MICRO_EDGE);
      }else if(data.type==='error'){
        this.overviewWorker=null;
        worker.terminate();
        this.overviewReady=true;
        this.requestDraw();
      }
    };
    worker.postMessage({action:'build',hashes:this.media.map(item=>item.hash)});
  }

  installOverview(pixels,available,edge){
    if(!pixels?.length||!available?.length||edge!==MICRO_EDGE)return;
    const tier=this.tiers.micro;
    tier.clear();
    this.configureTiers();
    const buffers=new Map();
    const now=performance.now();
    let found=0;
    for(let index=0;index<this.media.length&&index<available.length;index++){
      if(!available[index]||!this.valid[index])continue;
      const target=tier.allocate(index,null);if(!target)break;
      const {page,slot}=target,column=slot%page.columns,row=Math.floor(slot/page.columns),x=column*page.cell+1,y=row*page.cell+1;
      let atlas=buffers.get(page);if(!atlas){atlas=new Uint8Array(ATLAS_SIZE*ATLAS_SIZE*4);buffers.set(page,atlas)}
      const source=index*MICRO_EDGE*MICRO_EDGE*4;
      for(let py=0;py<MICRO_EDGE;py++){
        const from=source+py*MICRO_EDGE*4,to=((y+py)*ATLAS_SIZE+x)*4;
        atlas.set(pixels.subarray(from,from+MICRO_EDGE*4),to);
      }
      const uv=[(x+.5)/ATLAS_SIZE,(y+.5)/ATLAS_SIZE,(x+MICRO_EDGE-.5)/ATLAS_SIZE,(y+MICRO_EDGE-.5)/ATLAS_SIZE];
      const entry={index,slot,uv,lastUsed:now,page};
      page.entries.set(index,entry);tier.entries.set(index,entry);page.dirty=true;found++;
    }
    const gl=this.gl;
    for(const[page,atlas]of buffers){gl.bindTexture(gl.TEXTURE_2D,page.texture);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,ATLAS_SIZE,ATLAS_SIZE,gl.RGBA,gl.UNSIGNED_BYTE,atlas)}
    this.overviewFound=found;
    this.overviewReady=true;
    this.requestDraw();
  }

  settle(){
    if(!this.result||this.lost)return;
    if(this.screenItemSize()<MICRO_ONLY_SCREEN_PX){
      const visible=this.visibleIndexes(4);this.visibleCount=visible.length;this.visibleSet=new Set(visible);this.desired.clear();this.queue.length=0;this.queued.clear();this.originalDesired.clear();this.requestDraw();return;
    }
    super.settle();
  }

  drawUnderlay(){
    for(const page of this.tiers.micro.pages){page.rebuildBuffer();this.drawInstances(page.buffer,page.count,page.texture,1)}
  }

  drawMicroOnly(){
    const gl=this.gl;if(!gl||this.lost)return;
    gl.viewport(0,0,this.canvas.width,this.canvas.height);gl.clearColor(.055,.051,.059,1);gl.clear(gl.COLOR_BUFFER_BIT);gl.useProgram(this.program);gl.uniform2f(this.uViewport,Math.max(1,this.canvas.clientWidth),Math.max(1,this.canvas.clientHeight));gl.uniform2f(this.uPan,this.panX,this.panY);gl.uniform1f(this.uZoom,this.zoom);
    this.drawInstances(this.placeholderBuffer,this.placeholderCount||0,this.placeholderTexture,0);
    this.drawUnderlay();
    if(this.hoverIndex>=0&&this.valid[this.hoverIndex]){const o=this.hoverIndex*4,values=new Float32Array([this.geometry[o],this.geometry[o+1],this.geometry[o+2],this.geometry[o+3],0,0,1,1]);gl.bindBuffer(gl.ARRAY_BUFFER,this.hoverBuffer);gl.bufferData(gl.ARRAY_BUFFER,values,gl.DYNAMIC_DRAW);this.drawInstances(this.hoverBuffer,1,this.placeholderTexture,2)}
  }

  draw(){
    if(this.screenItemSize()<MICRO_ONLY_SCREEN_PX)return this.drawMicroOnly();
    super.draw();
  }

  stats(){return{...super.stats(),overviewEdge:MICRO_EDGE,overview:this.tiers?.micro?.entries?.size||0,overviewFound:this.overviewFound,overviewReady:this.overviewReady,overviewCapacity:this.tiers?.micro?.capacity?.()||0,overviewUntil:MICRO_ONLY_SCREEN_PX}}
}
