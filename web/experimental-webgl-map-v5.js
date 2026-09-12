import { browserMediaBlob, isHeicRecord } from './browser-thumbnail-fallback.js';
import { ExperimentalWebGLMapRenderer as BaseRenderer } from './experimental-webgl-map-v4.js';

const CLOSE_ORIGINAL_MAX_EDGE=8192;
const CLOSE_ORIGINAL_SCALE=1.6;

function sourceRecord(item){
  if(!item?.hash||item?.type!=='image')return null;
  return{
    hash:item.hash,
    filename:item.filename||'',
    mime:item.mime||'',
    kind:'image',
    urgent:true,
    width:Number(item.width)||0,
    height:Number(item.height)||0
  };
}

async function intrinsicBitmap(blob,targetEdge){
  const source=await createImageBitmap(blob,{imageOrientation:'from-image'});
  const longest=Math.max(source.width,source.height);
  const edge=Math.max(1,Math.min(longest,Math.round(Number(targetEdge)||longest)));
  if(longest<=edge)return{bitmap:source,edge:longest,width:source.width,height:source.height};
  const scale=edge/longest,width=Math.max(1,Math.round(source.width*scale)),height=Math.max(1,Math.round(source.height*scale));
  try{
    const bitmap=await createImageBitmap(source,{resizeWidth:width,resizeHeight:height,resizeQuality:'high'});
    return{bitmap,edge:Math.max(bitmap.width,bitmap.height),width:bitmap.width,height:bitmap.height};
  }finally{source.close?.()}
}

export class ExperimentalWebGLMapRenderer extends BaseRenderer{
  maxCloseOriginalEdge(){
    const glLimit=Number(this.gl?.getParameter?.(this.gl.MAX_TEXTURE_SIZE))||CLOSE_ORIGINAL_MAX_EDGE;
    return Math.max(1024,Math.min(CLOSE_ORIGINAL_MAX_EDGE,glLimit));
  }

  originalTargetEdge(){
    const physicalScreenEdge=this.screenItemSize()*(this.pixelRatio||1);
    return Math.min(this.maxCloseOriginalEdge(),Math.max(1024,Math.ceil(physicalScreenEdge*CLOSE_ORIGINAL_SCALE)));
  }

  async loadOriginal(job){
    const item=this.media[job.index],record=sourceRecord(item);
    if(!record)return;
    if(isHeicRecord(record))return super.loadOriginal(job);

    try{
      let blob=null;
      const response=await fetch(`/api/objects/${encodeURIComponent(item.hash)}`,{cache:'force-cache'});
      if(response.ok)blob=await response.blob();
      else blob=await browserMediaBlob(record).catch(()=>null);
      if(!blob)throw new Error(`Original ${response.status}`);
      if(job.token!==this.originalToken||!this.originalDesired.has(job.index))return;

      const targetEdge=Math.min(this.maxCloseOriginalEdge(),Math.max(1024,Number(job.edge)||this.originalTargetEdge()));
      const decoded=await intrinsicBitmap(blob,targetEdge);
      const bitmap=decoded.bitmap;
      try{
        if(job.token!==this.originalToken||!this.originalDesired.has(job.index))return;
        const gl=this.gl,texture=gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D,texture);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,bitmap);
        const previous=this.originalEntries.get(job.index);
        if(previous)gl.deleteTexture(previous.texture);
        this.originalEntries.set(job.index,{
          index:job.index,
          texture,
          lastUsed:performance.now(),
          edge:decoded.edge,
          intrinsicWidth:decoded.width,
          intrinsicHeight:decoded.height
        });
        this.evictOriginals();
        this.requestDraw();
      }finally{bitmap.close?.()}
    }catch(error){
      if(!String(error?.message||'').includes('404'))this.onError?.(error);
    }
  }

  stats(){return{...super.stats(),intrinsicCloseOriginals:true,closeOriginalMaxEdge:this.maxCloseOriginalEdge()}}
}
