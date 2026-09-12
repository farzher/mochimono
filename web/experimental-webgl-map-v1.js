const ATLAS_SIZE = 2048;
const LOAD_CONCURRENCY = 6;
const FAR_SCREEN_PX = 6;
const DETAIL_SCREEN_PX = 70;
const THUMB_VERSION = 3;

const VERTEX_SOURCE = `#version 300 es
precision highp float;
layout(location=0) in vec2 aCorner;
layout(location=1) in vec2 iCenter;
layout(location=2) in vec2 iSize;
layout(location=3) in vec4 iUv;
uniform vec2 uViewport;
uniform vec2 uPan;
uniform float uZoom;
out vec2 vUv;
out vec2 vLocal;
void main(){
  vec2 world = iCenter + aCorner * iSize;
  vec2 screen = uPan + world * uZoom;
  vec2 clip = vec2(screen.x / uViewport.x * 2.0 - 1.0, 1.0 - screen.y / uViewport.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  vLocal = aCorner + 0.5;
  vUv = mix(iUv.xy, iUv.zw, vLocal);
}`;

const FRAGMENT_SOURCE = `#version 300 es
precision mediump float;
in vec2 vUv;
in vec2 vLocal;
uniform sampler2D uTexture;
uniform int uMode;
out vec4 outColor;
void main(){
  if(uMode == 0){
    outColor = vec4(0.090, 0.082, 0.098, 1.0);
    return;
  }
  if(uMode == 2){
    float edge = min(min(vLocal.x, 1.0-vLocal.x), min(vLocal.y, 1.0-vLocal.y));
    if(edge > 0.045) discard;
    outColor = vec4(1.0, 1.0, 1.0, 0.92);
    return;
  }
  outColor = texture(uTexture, vUv);
}`;

function shader(gl, type, source) {
  const value = gl.createShader(type);
  gl.shaderSource(value, source);
  gl.compileShader(value);
  if (!gl.getShaderParameter(value, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(value) || 'WebGL shader compile failed';
    gl.deleteShader(value);
    throw new Error(message);
  }
  return value;
}

function program(gl) {
  const value = gl.createProgram();
  const vertex = shader(gl, gl.VERTEX_SHADER, VERTEX_SOURCE);
  const fragment = shader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SOURCE);
  gl.attachShader(value, vertex);
  gl.attachShader(value, fragment);
  gl.linkProgram(value);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(value, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(value) || 'WebGL program link failed';
    gl.deleteProgram(value);
    throw new Error(message);
  }
  return value;
}

function aspectSize(item, maxSide) {
  const width = Math.max(1, Number(item?.width) || 1);
  const height = Math.max(1, Number(item?.height) || 1);
  const ratio = width / height;
  return ratio >= 1 ? [maxSide, maxSide / ratio] : [maxSide * ratio, maxSide];
}

class AtlasPage {
  constructor(renderer, tier, pageIndex) {
    this.renderer = renderer;
    this.gl = renderer.gl;
    this.tier = tier;
    this.pageIndex = pageIndex;
    this.edge = tier.edge;
    this.cell = this.edge + 2;
    this.columns = Math.floor(ATLAS_SIZE / this.cell);
    this.capacity = this.columns * this.columns;
    this.free = Array.from({ length:this.capacity }, (_, index) => this.capacity - 1 - index);
    this.entries = new Map();
    this.dirty = true;
    this.count = 0;
    this.texture = this.gl.createTexture();
    this.buffer = this.gl.createBuffer();
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.texture);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
    this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, ATLAS_SIZE, ATLAS_SIZE, 0, this.gl.RGBA, this.gl.UNSIGNED_BYTE, null);
  }

  allocateSlot() {
    return this.free.length ? this.free.pop() : -1;
  }

  release(entry) {
    this.entries.delete(entry.index);
    this.free.push(entry.slot);
    this.dirty = true;
  }

  upload(index, slot, bitmap) {
    const gl = this.gl;
    const column = slot % this.columns;
    const row = Math.floor(slot / this.columns);
    const x = column * this.cell + 1;
    const y = row * this.cell + 1;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    const uv = [
      (x + 0.5) / ATLAS_SIZE,
      (y + 0.5) / ATLAS_SIZE,
      (x + bitmap.width - 0.5) / ATLAS_SIZE,
      (y + bitmap.height - 0.5) / ATLAS_SIZE
    ];
    const entry = { index, slot, uv, lastUsed:performance.now(), page:this };
    this.entries.set(index, entry);
    this.dirty = true;
    return entry;
  }

  rebuildBuffer() {
    if (!this.dirty) return;
    const geometry = this.renderer.geometry;
    const values = new Float32Array(this.entries.size * 8);
    let at = 0;
    for (const entry of this.entries.values()) {
      const offset = entry.index * 4;
      values[at++] = geometry[offset];
      values[at++] = geometry[offset + 1];
      values[at++] = geometry[offset + 2];
      values[at++] = geometry[offset + 3];
      values[at++] = entry.uv[0];
      values[at++] = entry.uv[1];
      values[at++] = entry.uv[2];
      values[at++] = entry.uv[3];
    }
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, values, this.gl.DYNAMIC_DRAW);
    this.count = this.entries.size;
    this.dirty = false;
  }

  destroy() {
    this.gl.deleteTexture(this.texture);
    this.gl.deleteBuffer(this.buffer);
    this.entries.clear();
    this.free.length = 0;
  }
}

class AtlasTier {
  constructor(renderer, name, edge, maxPages) {
    this.renderer = renderer;
    this.name = name;
    this.edge = edge;
    this.maxPages = maxPages;
    this.pages = [];
    this.entries = new Map();
  }

  capacity() {
    const cell = this.edge + 2;
    const perPage = Math.floor(ATLAS_SIZE / cell) ** 2;
    return perPage * this.maxPages;
  }

  get(index) {
    const entry = this.entries.get(index);
    if (entry) entry.lastUsed = performance.now();
    return entry || null;
  }

  allocate(index, visibleSet) {
    for (const page of this.pages) {
      const slot = page.allocateSlot();
      if (slot >= 0) return { page, slot };
    }
    if (this.pages.length < this.maxPages) {
      const page = new AtlasPage(this.renderer, this, this.pages.length);
      this.pages.push(page);
      return { page, slot:page.allocateSlot() };
    }
    let victim = null;
    for (const entry of this.entries.values()) {
      if (visibleSet?.has(entry.index)) continue;
      if (!victim || entry.lastUsed < victim.lastUsed) victim = entry;
    }
    if (!victim) return null;
    this.entries.delete(victim.index);
    victim.page.release(victim);
    return { page:victim.page, slot:victim.page.allocateSlot() };
  }

  upload(index, bitmap, visibleSet) {
    const old = this.entries.get(index);
    if (old) return old;
    const target = this.allocate(index, visibleSet);
    if (!target) return null;
    const entry = target.page.upload(index, target.slot, bitmap);
    this.entries.set(index, entry);
    return entry;
  }

  clear() {
    for (const page of this.pages) page.destroy();
    this.pages.length = 0;
    this.entries.clear();
  }
}

export class ExperimentalWebGLMapRenderer {
  constructor(canvas, { thumbVersion=THUMB_VERSION, onError=null } = {}) {
    this.canvas = canvas;
    this.thumbVersion = thumbVersion;
    this.onError = onError;
    this.media = [];
    this.result = null;
    this.cell = 96;
    this.baseSide = 84;
    this.geometry = new Float32Array(0);
    this.valid = new Uint8Array(0);
    this.spatial = new Map();
    this.spatial.bucket = 8;
    this.panX = 0;
    this.panY = 0;
    this.zoom = 1;
    this.hoverIndex = -1;
    this.sceneToken = 0;
    this.queue = [];
    this.queued = new Set();
    this.activeLoads = 0;
    this.desired = new Map();
    this.visibleSet = new Set();
    this.visibleCount = 0;
    this.drawFrame = 0;
    this.failedUntil = new Map();
    this.lost = false;
    this.initGl();
    this.canvas.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      this.lost = true;
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.lost = false;
      const scene = this.result ? { media:this.media, result:this.result, cell:this.cell } : null;
      this.initGl();
      if (scene) this.setScene(scene);
      this.setCamera(this.panX, this.panY, this.zoom);
      this.settle();
    });
  }

  initGl() {
    const gl = this.canvas.getContext('webgl2', {
      alpha:false,
      antialias:false,
      depth:false,
      stencil:false,
      premultipliedAlpha:false,
      preserveDrawingBuffer:false,
      powerPreference:'high-performance'
    });
    if (!gl) throw new Error('WebGL2 is required for experimental 2D views.');
    this.gl = gl;
    this.program = program(gl);
    this.uViewport = gl.getUniformLocation(this.program, 'uViewport');
    this.uPan = gl.getUniformLocation(this.program, 'uPan');
    this.uZoom = gl.getUniformLocation(this.program, 'uZoom');
    this.uTexture = gl.getUniformLocation(this.program, 'uTexture');
    this.uMode = gl.getUniformLocation(this.program, 'uMode');

    this.cornerBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -0.5,-0.5, 0.5,-0.5, -0.5,0.5,
      -0.5,0.5, 0.5,-0.5, 0.5,0.5
    ]), gl.STATIC_DRAW);

    this.placeholderBuffer = gl.createBuffer();
    this.hoverBuffer = gl.createBuffer();
    this.placeholderTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.placeholderTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([24,22,25,255]));
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this.tiers = {
      small:new AtlasTier(this, 'small', 64, 3),
      detail:new AtlasTier(this, 'detail', 192, 4)
    };
    this.resize();
  }

  destroy() {
    cancelAnimationFrame(this.drawFrame);
    this.drawFrame = 0;
    this.sceneToken++;
    this.queue.length = 0;
    this.queued.clear();
    this.desired.clear();
    this.visibleSet.clear();
    for (const tier of Object.values(this.tiers || {})) tier.clear();
    const gl = this.gl;
    if (gl) {
      gl.deleteBuffer(this.cornerBuffer);
      gl.deleteBuffer(this.placeholderBuffer);
      gl.deleteBuffer(this.hoverBuffer);
      gl.deleteTexture(this.placeholderTexture);
      gl.deleteProgram(this.program);
    }
  }

  resetTextures() {
    this.sceneToken++;
    this.queue.length = 0;
    this.queued.clear();
    this.desired.clear();
    this.visibleSet.clear();
    this.failedUntil.clear();
    for (const tier of Object.values(this.tiers)) tier.clear();
  }

  resize() {
    const ratio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const width = Math.max(1, Math.round(this.canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * ratio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.pixelRatio = ratio;
    this.requestDraw();
  }

  setScene({ media, result, cell }) {
    this.resetTextures();
    this.media = Array.isArray(media) ? media : [];
    this.result = result || null;
    this.cell = Math.max(1, Number(cell) || 96);
    this.baseSide = this.cell * 0.88;
    const count = this.media.length;
    this.geometry = new Float32Array(count * 4);
    this.valid = new Uint8Array(count);
    this.spatial = new Map();
    this.spatial.bucket = 8;
    const instances = new Float32Array(count * 8);
    let visible = 0;
    for (let index = 0; index < count; index++) {
      const x = Number(result?.x?.[index]);
      const y = Number(result?.y?.[index]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) continue;
      const [width, height] = aspectSize(this.media[index], this.baseSide);
      const centerX = (x + 0.5) * this.cell;
      const centerY = (y + 0.5) * this.cell;
      const offset = index * 4;
      this.geometry[offset] = centerX;
      this.geometry[offset + 1] = centerY;
      this.geometry[offset + 2] = width;
      this.geometry[offset + 3] = height;
      this.valid[index] = 1;
      const at = visible * 8;
      instances[at] = centerX;
      instances[at + 1] = centerY;
      instances[at + 2] = width;
      instances[at + 3] = height;
      instances[at + 4] = 0;
      instances[at + 5] = 0;
      instances[at + 6] = 1;
      instances[at + 7] = 1;
      visible++;
      const bucket = this.spatial.bucket;
      const key = `${Math.floor(x / bucket)}:${Math.floor(y / bucket)}`;
      let list = this.spatial.get(key);
      if (!list) this.spatial.set(key, list = []);
      list.push(index);
    }
    this.placeholderCount = visible;
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.placeholderBuffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, instances.subarray(0, visible * 8), this.gl.STATIC_DRAW);
    this.hoverIndex = -1;
    this.requestDraw();
  }

  setCamera(panX, panY, zoom) {
    this.panX = Number(panX) || 0;
    this.panY = Number(panY) || 0;
    this.zoom = Math.max(0.0001, Number(zoom) || 1);
    this.requestDraw();
  }

  screenItemSize() {
    return this.baseSide * this.zoom;
  }

  visibleIndexes(overscanCells=2) {
    if (!this.result || !this.spatial) return [];
    const z = this.zoom;
    const left = (-this.panX) / z / this.cell - overscanCells;
    const top = (-this.panY) / z / this.cell - overscanCells;
    const right = (this.canvas.clientWidth - this.panX) / z / this.cell + overscanCells;
    const bottom = (this.canvas.clientHeight - this.panY) / z / this.cell + overscanCells;
    const bucket = this.spatial.bucket || 8;
    const out = [];
    for (let by = Math.floor(top / bucket); by <= Math.floor(bottom / bucket); by++) {
      for (let bx = Math.floor(left / bucket); bx <= Math.floor(right / bucket); bx++) {
        for (const index of this.spatial.get(`${bx}:${by}`) || []) {
          const x = Number(this.result.x[index]);
          const y = Number(this.result.y[index]);
          if (x >= left && x <= right && y >= top && y <= bottom) out.push(index);
        }
      }
    }
    return out;
  }

  settle() {
    if (!this.result || this.lost) return;
    const screenPx = this.screenItemSize();
    const visible = this.visibleIndexes(screenPx < 16 ? 3 : 2);
    this.visibleCount = visible.length;
    this.visibleSet = new Set(visible);
    this.desired.clear();
    if (screenPx < FAR_SCREEN_PX || !visible.length) {
      this.queue.length = 0;
      this.queued.clear();
      this.requestDraw();
      return;
    }

    const tier = screenPx >= DETAIL_SCREEN_PX ? this.tiers.detail : this.tiers.small;
    const maxWanted = Math.min(tier.capacity(), tier.name === 'small' ? 2800 : 380);
    let wanted = visible;
    if (visible.length > maxWanted) {
      const worldCenterX = (this.canvas.clientWidth * 0.5 - this.panX) / this.zoom;
      const worldCenterY = (this.canvas.clientHeight * 0.5 - this.panY) / this.zoom;
      wanted = visible.map(index => {
        const o = index * 4;
        const dx = this.geometry[o] - worldCenterX;
        const dy = this.geometry[o + 1] - worldCenterY;
        return [index, dx*dx + dy*dy];
      }).sort((a,b) => a[1] - b[1]).slice(0, maxWanted).map(entry => entry[0]);
    }
    for (const index of wanted) {
      this.desired.set(index, tier.name);
      const existing = tier.get(index);
      if (!existing) this.enqueue(index, tier);
    }
    this.pump();
    this.requestDraw();
  }

  enqueue(index, tier) {
    const key = `${tier.name}:${index}`;
    if (this.queued.has(key) || tier.entries.has(index)) return;
    if ((this.failedUntil.get(key) || 0) > Date.now()) return;
    this.queued.add(key);
    this.queue.push({ index, tier, key, sceneToken:this.sceneToken });
  }

  pump() {
    while (this.activeLoads < LOAD_CONCURRENCY && this.queue.length) {
      const job = this.queue.shift();
      this.queued.delete(job.key);
      if (job.sceneToken !== this.sceneToken || this.desired.get(job.index) !== job.tier.name || job.tier.entries.has(job.index)) continue;
      this.activeLoads++;
      this.load(job).finally(() => {
        this.activeLoads--;
        this.pump();
      });
    }
  }

  async load(job) {
    const item = this.media[job.index];
    if (!item) return;
    try {
      const response = await fetch(`/api/thumbs/${encodeURIComponent(item.hash)}?v=${this.thumbVersion}&edge=${job.tier.edge}`, { cache:'force-cache' });
      if (!response.ok) throw new Error(`Thumbnail ${response.status}`);
      const blob = await response.blob();
      if (job.sceneToken !== this.sceneToken || this.desired.get(job.index) !== job.tier.name) return;
      const sourceWidth = Number(item.width) || 0;
      const sourceHeight = Number(item.height) || 0;
      const knownSize = sourceWidth > 0 && sourceHeight > 0;
      const scale = knownSize ? Math.min(1, job.tier.edge / Math.max(sourceWidth, sourceHeight)) : 1;
      const width = knownSize ? Math.max(1, Math.round(sourceWidth * scale)) : job.tier.edge;
      const height = knownSize ? Math.max(1, Math.round(sourceHeight * scale)) : job.tier.edge;
      const bitmap = await createImageBitmap(blob, { resizeWidth:width, resizeHeight:height, resizeQuality:'medium' });
      try {
        if (job.sceneToken !== this.sceneToken || this.desired.get(job.index) !== job.tier.name) return;
        job.tier.upload(job.index, bitmap, this.visibleSet);
      } finally {
        bitmap.close?.();
      }
      this.requestDraw();
    } catch (error) {
      this.failedUntil.set(job.key, Date.now() + 20_000);
      if (!String(error?.message || '').includes('404')) this.onError?.(error);
    }
  }

  requestDraw() {
    if (this.drawFrame || this.lost) return;
    this.drawFrame = requestAnimationFrame(() => {
      this.drawFrame = 0;
      this.draw();
    });
  }

  bindInstanceBuffer(buffer) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    const stride = 8 * 4;
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 2 * 4);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, 4 * 4);
    gl.vertexAttribDivisor(3, 1);
  }

  drawInstances(buffer, count, texture, mode) {
    if (!count) return;
    const gl = this.gl;
    this.bindInstanceBuffer(buffer);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(this.uTexture, 0);
    gl.uniform1i(this.uMode, mode);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
  }

  draw() {
    if (!this.gl || this.lost) return;
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.055, 0.051, 0.059, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.uniform2f(this.uViewport, Math.max(1, this.canvas.clientWidth), Math.max(1, this.canvas.clientHeight));
    gl.uniform2f(this.uPan, this.panX, this.panY);
    gl.uniform1f(this.uZoom, this.zoom);

    this.drawInstances(this.placeholderBuffer, this.placeholderCount || 0, this.placeholderTexture, 0);
    const screenPx = this.screenItemSize();
    if (screenPx >= FAR_SCREEN_PX) {
      for (const page of this.tiers.small.pages) {
        page.rebuildBuffer();
        this.drawInstances(page.buffer, page.count, page.texture, 1);
      }
      if (screenPx >= DETAIL_SCREEN_PX) {
        for (const page of this.tiers.detail.pages) {
          page.rebuildBuffer();
          this.drawInstances(page.buffer, page.count, page.texture, 1);
        }
      }
    }
    if (this.hoverIndex >= 0 && this.valid[this.hoverIndex]) {
      const o = this.hoverIndex * 4;
      const values = new Float32Array([
        this.geometry[o], this.geometry[o+1], this.geometry[o+2], this.geometry[o+3], 0,0,1,1
      ]);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.hoverBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, values, gl.DYNAMIC_DRAW);
      this.drawInstances(this.hoverBuffer, 1, this.placeholderTexture, 2);
    }
  }

  hitTest(screenX, screenY) {
    if (!this.result || !this.spatial) return -1;
    const worldX = (screenX - this.panX) / this.zoom;
    const worldY = (screenY - this.panY) / this.zoom;
    const cellX = worldX / this.cell;
    const cellY = worldY / this.cell;
    const bucket = this.spatial.bucket || 8;
    const bx = Math.floor(cellX / bucket);
    const by = Math.floor(cellY / bucket);
    let best = -1;
    let bestDistance = Infinity;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      for (const index of this.spatial.get(`${bx+ox}:${by+oy}`) || []) {
        const o = index * 4;
        const cx = this.geometry[o], cy = this.geometry[o+1], w = this.geometry[o+2], h = this.geometry[o+3];
        if (Math.abs(worldX-cx) > w*0.5 || Math.abs(worldY-cy) > h*0.5) continue;
        const dx = worldX-cx, dy = worldY-cy, distance = dx*dx + dy*dy;
        if (distance < bestDistance) { bestDistance = distance; best = index; }
      }
    }
    return best;
  }

  setHover(index) {
    const next = Number.isInteger(index) ? index : -1;
    if (next === this.hoverIndex) return;
    this.hoverIndex = next;
    this.requestDraw();
  }

  stats() {
    return {
      backend:'webgl2',
      visible:this.visibleCount,
      small:this.tiers.small.entries.size,
      detail:this.tiers.detail.entries.size,
      queued:this.queue.length,
      loading:this.activeLoads,
      screenPx:this.screenItemSize()
    };
  }
}
