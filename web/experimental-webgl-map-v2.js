import { ExperimentalWebGLMapRenderer as BaseRenderer } from './experimental-webgl-map-v1.js';

const LOAD_CONCURRENCY = 12;

function aspectSize(item, maxSide) {
  const width = Math.max(1, Number(item?.width) || 1);
  const height = Math.max(1, Number(item?.height) || 1);
  const ratio = width / height;
  return ratio >= 1 ? [maxSide, maxSide / ratio] : [maxSide * ratio, maxSide];
}

export class ExperimentalWebGLMapRenderer extends BaseRenderer {
  constructor(canvas, options = {}) {
    super(canvas, options);
    // The first renderer topped out at 192 px, which became visibly soft when
    // zooming in. Keep the same bounded atlas, but use a 384 px close tier.
    this.tiers.detail.edge = 384;
  }

  setScene(scene) {
    super.setScene(scene);
    // Use more of each layout cell now that the quads preserve aspect ratio.
    // This keeps a small gutter without returning to square cropping.
    this.baseSide = this.cell * 0.96;
    const instances = new Float32Array(this.media.length * 8);
    let count = 0;
    for (let index = 0; index < this.media.length; index++) {
      if (!this.valid[index]) continue;
      const offset = index * 4;
      const [width, height] = aspectSize(this.media[index], this.baseSide);
      this.geometry[offset + 2] = width;
      this.geometry[offset + 3] = height;
      const at = count * 8;
      instances[at] = this.geometry[offset];
      instances[at + 1] = this.geometry[offset + 1];
      instances[at + 2] = width;
      instances[at + 3] = height;
      instances[at + 4] = 0;
      instances[at + 5] = 0;
      instances[at + 6] = 1;
      instances[at + 7] = 1;
      count++;
    }
    this.placeholderCount = count;
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.placeholderBuffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, instances.subarray(0, count * 8), this.gl.STATIC_DRAW);
    for (const tier of Object.values(this.tiers)) for (const page of tier.pages) page.dirty = true;
    this.requestDraw();
  }

  settle() {
    if (!this.result || this.lost) return;
    const screenPx = this.screenItemSize();
    const visible = this.visibleIndexes(screenPx < 16 ? 3 : 2);
    this.visibleCount = visible.length;
    this.visibleSet = new Set(visible);
    this.desired.clear();
    if (screenPx < 6 || !visible.length) {
      this.queue.length = 0;
      this.queued.clear();
      this.requestDraw();
      return;
    }

    const tier = screenPx >= 70 ? this.tiers.detail : this.tiers.small;
    const maxWanted = Math.min(tier.capacity(), tier.name === 'small' ? 3200 : 96);
    const worldCenterX = (this.canvas.clientWidth * 0.5 - this.panX) / this.zoom;
    const worldCenterY = (this.canvas.clientHeight * 0.5 - this.panY) / this.zoom;
    let wanted = visible.map(index => {
      const o = index * 4;
      const dx = this.geometry[o] - worldCenterX;
      const dy = this.geometry[o + 1] - worldCenterY;
      return [index, dx * dx + dy * dy];
    }).sort((a,b) => a[1] - b[1]).slice(0, maxWanted).map(entry => entry[0]);

    for (const index of wanted) {
      this.desired.set(index, tier.name);
      if (!tier.get(index)) this.enqueue(index, tier);
    }
    this.pump();
    this.requestDraw();
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
      let response = await fetch(`/api/thumbs/${encodeURIComponent(item.hash)}?v=${this.thumbVersion}&edge=${job.tier.edge}`, { cache:'force-cache' });
      if (response.status === 404 && window.mochimonoThumbnails?.ensureHashes) {
        // WebGL has no DOM card for thumbs.js to observe. Explicitly ask the
        // normal thumbnail manager to generate missing visible thumbnails.
        const ensured = await window.mochimonoThumbnails.ensureHashes([item.hash], { background:false });
        if (!ensured?.ready?.includes(item.hash)) return;
        if (job.sceneToken !== this.sceneToken || this.desired.get(job.index) !== job.tier.name) return;
        response = await fetch(`/api/thumbs/${encodeURIComponent(item.hash)}?v=${this.thumbVersion}&edge=${job.tier.edge}`, { cache:'force-cache' });
      }
      if (!response.ok) throw new Error(`Thumbnail ${response.status}`);
      const blob = await response.blob();
      if (job.sceneToken !== this.sceneToken || this.desired.get(job.index) !== job.tier.name) return;
      const sourceWidth = Number(item.width) || 0;
      const sourceHeight = Number(item.height) || 0;
      const knownSize = sourceWidth > 0 && sourceHeight > 0;
      const scale = knownSize ? Math.min(1, job.tier.edge / Math.max(sourceWidth, sourceHeight)) : 1;
      const width = knownSize ? Math.max(1, Math.round(sourceWidth * scale)) : job.tier.edge;
      const height = knownSize ? Math.max(1, Math.round(sourceHeight * scale)) : job.tier.edge;
      const bitmap = await createImageBitmap(blob, { resizeWidth:width, resizeHeight:height, resizeQuality:'high' });
      try {
        if (job.sceneToken !== this.sceneToken || this.desired.get(job.index) !== job.tier.name) return;
        job.tier.upload(job.index, bitmap, this.visibleSet);
      } finally {
        bitmap.close?.();
      }
      this.requestDraw();
    } catch (error) {
      this.failedUntil.set(job.key, Date.now() + 5000);
      if (!String(error?.message || '').includes('404')) this.onError?.(error);
    }
  }

  stats() {
    const base = super.stats();
    return { ...base, detailEdge:this.tiers.detail.edge, concurrency:LOAD_CONCURRENCY };
  }
}
