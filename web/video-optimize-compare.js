const viewer = document.querySelector('#viewer');
const compare = document.querySelector('.video-optimize-compare');
const canvas = compare?.querySelector('[data-canvas]');
const original = compare?.querySelector('[data-o]');
const optimized = compare?.querySelector('[data-a]');
const controls = document.querySelector('[data-controls]');
const play = document.querySelector('[data-play]');
const rightCard = document.querySelector('.video-optimize-card-right');

if (viewer && compare && canvas && original && optimized) {
  const ctx = canvas.getContext('2d', { alpha:false });
  const nativeDrawImage = ctx.drawImage.bind(ctx);
  const nativeFillRect = ctx.fillRect.bind(ctx);
  const nativeSave = ctx.save.bind(ctx);
  const nativeRestore = ctx.restore.bind(ctx);
  const nativeBeginPath = ctx.beginPath.bind(ctx);
  const nativeRect = ctx.rect.bind(ctx);
  const nativeClip = ctx.clip.bind(ctx);
  const nativeSetTransform = ctx.setTransform.bind(ctx);
  const requestFrame = HTMLVideoElement.prototype.requestVideoFrameCallback;

  const MIN_SCALE = .01;
  const MAX_SCALE = 16;
  const NATIVE_SCALE = 1;
  const NATIVE_SNAP = .025;
  const PAN_START = 3;
  const MAX_QUEUE = 8;
  const pointers = new Map();

  let painting = false;
  let watcherGeneration = 0;
  let sourceOffset = NaN;
  let sourceFrameDuration = 1 / 30;
  let optimizedFrameDuration = 1 / 30;
  let previousSourceTime = NaN;
  let previousOptimizedTime = NaN;
  let sourceFrames = [];
  let optimizedFrames = [];
  let lastPair = null;
  let lastPreviewSrc = '';
  let pendingRestore = null;
  let restoring = false;
  let view = { scale:1, x:0, y:0 };
  let metrics = null;
  let fitLocked = true;
  let pan = null;
  let pinch = null;

  const active = () => viewer.classList.contains('video-optimize-active');
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  const style = document.createElement('style');
  style.textContent = `
.video-optimize-compare{cursor:grab}
.video-optimize-compare.video-optimize-panning{cursor:grabbing}
.video-optimize-divider{cursor:e-resize}
.video-optimize-status-row{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0;margin-top:6px}
.video-optimize-status-row>.video-optimize-status{min-width:0;margin-top:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.video-optimize-zoom-readout{flex:0 0 auto;color:#b9b1ad;font-size:11px;font-weight:700;font-variant-numeric:tabular-nums}
@media(max-width:760px){.video-optimize-zoom-readout{font-size:10.5px}}
`;
  document.head.append(style);

  let zoomLabel = rightCard?.querySelector('.video-optimize-zoom-readout') || null;
  const status = rightCard?.querySelector('.video-optimize-status') || null;
  if (rightCard && status && !zoomLabel) {
    const row = document.createElement('div');
    row.className = 'video-optimize-status-row';
    status.before(row);
    row.append(status);
    zoomLabel = document.createElement('div');
    zoomLabel.className = 'video-optimize-zoom-readout';
    zoomLabel.textContent = '100%';
    row.append(zoomLabel);
  }

  // video-optimize.js used to own a second synchronization loop that repeatedly
  // changed playbackRate and sought Original. Disable that loop at its scheduling
  // boundary; this controller is now the only frame compositor.
  if (requestFrame) {
    Object.defineProperty(optimized, 'requestVideoFrameCallback', {
      configurable:true,
      value:() => 0
    });
  }

  // Base UI code still calls drawComposite() after seeks/divider changes. Keep
  // those calls from painting unsynchronized live video elements over the matched
  // frame pair. This controller uses the captured native methods below.
  ctx.fillRect = function(...args) {
    if (active() && !painting) return;
    return nativeFillRect(...args);
  };
  ctx.drawImage = function(...args) {
    if (active() && !painting && (args[0] === original || args[0] === optimized)) return;
    return nativeDrawImage(...args);
  };

  function closeFrame(frame) {
    try { frame?.close?.(); } catch {}
  }

  function clearQueue(queue) {
    for (const entry of queue) closeFrame(entry.frame);
    queue.length = 0;
  }

  function clearFrames(keepLast = false) {
    clearQueue(sourceFrames);
    clearQueue(optimizedFrames);
    previousSourceTime = NaN;
    previousOptimizedTime = NaN;
    if (!keepLast && lastPair) {
      closeFrame(lastPair.source);
      closeFrame(lastPair.optimized);
      lastPair = null;
    }
  }

  function snapshot(video, mediaTime) {
    if (typeof VideoFrame !== 'function') return video;
    try {
      return new VideoFrame(video, { timestamp:Math.round(Math.max(0, mediaTime) * 1e6) });
    } catch {
      return video;
    }
  }

  function updateFrameDuration(kind, mediaTime) {
    if (kind === 'source') {
      if (Number.isFinite(previousSourceTime)) {
        const delta = Math.abs(mediaTime - previousSourceTime);
        if (delta >= .004 && delta <= .15) sourceFrameDuration = sourceFrameDuration * .7 + delta * .3;
      }
      previousSourceTime = mediaTime;
      return;
    }
    if (Number.isFinite(previousOptimizedTime)) {
      const delta = Math.abs(mediaTime - previousOptimizedTime);
      if (delta >= .004 && delta <= .15) optimizedFrameDuration = optimizedFrameDuration * .7 + delta * .3;
    }
    previousOptimizedTime = mediaTime;
  }

  function captureOffset(force = false) {
    if (original.readyState < 1 || optimized.readyState < 1) return false;
    const next = Number(original.currentTime) - Number(optimized.currentTime);
    if (!Number.isFinite(next)) return false;
    // The preview always represents a contiguous source window, so this offset
    // is the source timestamp corresponding to preview t=0.
    if (force || !Number.isFinite(sourceOffset) || Number(optimized.currentTime) < .12) sourceOffset = next;
    return Number.isFinite(sourceOffset);
  }

  function tolerance() {
    return Math.max(.006, Math.max(sourceFrameDuration, optimizedFrameDuration) * .58);
  }

  function normalizedSourceTime(entry) {
    return entry.time - sourceOffset;
  }

  function trimQueue(queue) {
    while (queue.length > MAX_QUEUE) {
      const removed = queue.shift();
      closeFrame(removed?.frame);
    }
  }

  function setPair(sourceEntry, optimizedEntry) {
    const previous = lastPair;
    lastPair = {
      source:sourceEntry.frame,
      optimized:optimizedEntry.frame,
      sourceTime:sourceEntry.time,
      optimizedTime:optimizedEntry.time
    };
    sourceEntry.frame = null;
    optimizedEntry.frame = null;
    if (previous) {
      closeFrame(previous.source);
      closeFrame(previous.optimized);
    }
    drawPair();
  }

  function matchFrames() {
    if (!active() || !Number.isFinite(sourceOffset) || !sourceFrames.length || !optimizedFrames.length) return;
    const limit = tolerance();

    while (optimizedFrames.length && sourceFrames.length) {
      const target = optimizedFrames[0];
      let bestIndex = -1;
      let bestDistance = Infinity;
      for (let index = 0; index < sourceFrames.length; index++) {
        const distance = Math.abs(normalizedSourceTime(sourceFrames[index]) - target.time);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = index;
        }
      }

      if (bestIndex >= 0 && bestDistance <= limit) {
        const optimizedEntry = optimizedFrames.shift();
        const sourceEntry = sourceFrames.splice(bestIndex, 1)[0];
        for (let index = bestIndex - 1; index >= 0; index--) {
          const stale = sourceFrames.splice(index, 1)[0];
          closeFrame(stale?.frame);
        }
        setPair(sourceEntry, optimizedEntry);
        continue;
      }

      const newestSource = normalizedSourceTime(sourceFrames[sourceFrames.length - 1]);
      if (newestSource > target.time + limit) {
        closeFrame(optimizedFrames.shift()?.frame);
        continue;
      }
      break;
    }
  }

  function addFrame(kind, video, mediaTime) {
    if (!active() || !Number.isFinite(mediaTime)) return;
    updateFrameDuration(kind, mediaTime);
    if (!Number.isFinite(sourceOffset)) captureOffset();
    const entry = { time:mediaTime, frame:snapshot(video, mediaTime) };
    const queue = kind === 'source' ? sourceFrames : optimizedFrames;
    queue.push(entry);
    trimQueue(queue);
    matchFrames();
  }

  function watch(video, kind, generation) {
    if (!requestFrame) return;
    requestFrame.call(video, (_, metadata) => {
      if (generation !== watcherGeneration) return;
      addFrame(kind, video, Number(metadata?.mediaTime ?? video.currentTime));
      watch(video, kind, generation);
    });
  }

  function startWatchers(keepLast = true) {
    const generation = ++watcherGeneration;
    clearFrames(keepLast);
    if (requestFrame) {
      watch(original, 'source', generation);
      watch(optimized, 'optimized', generation);
    }
  }

  function referenceMetrics() {
    const pixelWidth = Number(original.videoWidth) || Number(lastPair?.source?.displayWidth) || Number(optimized.videoWidth) || 0;
    const pixelHeight = Number(original.videoHeight) || Number(lastPair?.source?.displayHeight) || Number(optimized.videoHeight) || 0;
    const viewportWidth = compare.clientWidth || 0;
    const viewportHeight = compare.clientHeight || 0;
    if (!pixelWidth || !pixelHeight || !viewportWidth || !viewportHeight) return null;
    const dpr = Math.max(1, Number(window.devicePixelRatio) || 1);
    const nativeWidth = pixelWidth / dpr;
    const nativeHeight = pixelHeight / dpr;
    return {
      dpr,
      pixelWidth,
      pixelHeight,
      nativeWidth,
      nativeHeight,
      viewportWidth,
      viewportHeight,
      fit:Math.min(viewportWidth / nativeWidth, viewportHeight / nativeHeight)
    };
  }

  function refreshMetrics() {
    const next = referenceMetrics();
    if (!next) return false;
    metrics = next;
    return true;
  }

  function updateZoomLabel() {
    if (!zoomLabel) return;
    const percent = Math.max(1, view.scale * 100);
    zoomLabel.textContent = `${percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`;
  }

  function clampPan() {
    if (!metrics && !refreshMetrics()) return;
    const displayedWidth = metrics.nativeWidth * view.scale;
    const displayedHeight = metrics.nativeHeight * view.scale;
    const extraX = Math.max(0, (displayedWidth - metrics.viewportWidth) / 2);
    const extraY = Math.max(0, (displayedHeight - metrics.viewportHeight) / 2);
    const maxX = metrics.viewportWidth * .9 + extraX;
    const maxY = metrics.viewportHeight * .9 + extraY;
    view.x = clamp(view.x, -maxX, maxX);
    view.y = clamp(view.y, -maxY, maxY);
  }

  function resizeCanvas() {
    const dpr = Math.max(1, Math.min(2, Number(window.devicePixelRatio) || 1));
    const width = Math.max(1, Math.round((compare.clientWidth || 1) * dpr));
    const height = Math.max(1, Math.round((compare.clientHeight || 1) * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    nativeSetTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawPair() {
    if (!active() || !lastPair || !refreshMetrics()) return;
    clampPan();
    resizeCanvas();
    const width = metrics.viewportWidth;
    const height = metrics.viewportHeight;
    const drawWidth = metrics.nativeWidth * view.scale;
    const drawHeight = metrics.nativeHeight * view.scale;
    const x = (width - drawWidth) / 2 + view.x;
    const y = (height - drawHeight) / 2 + view.y;
    const split = clamp(parseFloat(getComputedStyle(compare).getPropertyValue('--split')) || 50, 0, 100);

    painting = true;
    try {
      ctx.fillStyle = '#050505';
      nativeFillRect(0, 0, width, height);
      nativeDrawImage(lastPair.source, x, y, drawWidth, drawHeight);
      nativeSave();
      nativeBeginPath();
      nativeRect(width * split / 100, 0, width * (1 - split / 100), height);
      nativeClip();
      nativeDrawImage(lastPair.optimized, x, y, drawWidth, drawHeight);
      nativeRestore();
    } catch {}
    finally { painting = false; }
    updateZoomLabel();
  }

  function fitView() {
    if (!refreshMetrics()) return false;
    fitLocked = true;
    view = { scale:metrics.fit, x:0, y:0 };
    drawPair();
    return true;
  }

  function snapNative(previous, requested) {
    const next = clamp(requested, MIN_SCALE, MAX_SCALE);
    if (Math.abs(previous - NATIVE_SCALE) < .0005) return next;
    if ((previous < NATIVE_SCALE && next >= NATIVE_SCALE) || (previous > NATIVE_SCALE && next <= NATIVE_SCALE)) return NATIVE_SCALE;
    if (previous < NATIVE_SCALE - NATIVE_SNAP && next >= NATIVE_SCALE - NATIVE_SNAP) return NATIVE_SCALE;
    if (previous > NATIVE_SCALE + NATIVE_SNAP && next <= NATIVE_SCALE + NATIVE_SNAP) return NATIVE_SCALE;
    return next;
  }

  function zoomAt(requested, clientX, clientY) {
    if (!metrics && !refreshMetrics()) return;
    const rect = compare.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const previous = view.scale;
    const next = snapNative(previous, requested);
    if (Math.abs(next - previous) < .0001) return;
    const px = clientX - (rect.left + rect.width / 2);
    const py = clientY - (rect.top + rect.height / 2);
    const anchorX = (px - view.x) / previous;
    const anchorY = (py - view.y) / previous;
    view.scale = next;
    view.x = px - anchorX * next;
    view.y = py - anchorY * next;
    fitLocked = false;
    clampPan();
    drawPair();
  }

  compare.addEventListener('wheel', event => {
    if (!active() || !lastPair) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const rect = compare.getBoundingClientRect();
    let delta = event.deltaY;
    if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) delta *= 16;
    else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) delta *= rect.height;
    zoomAt(view.scale * Math.exp(-delta * .0015), event.clientX, event.clientY);
  }, { passive:false, capture:true });

  function dividerHit(event) {
    if (event.target.closest?.('.video-optimize-divider')) return true;
    const rect = compare.getBoundingClientRect();
    const split = clamp(parseFloat(getComputedStyle(compare).getPropertyValue('--split')) || 50, 0, 100);
    return Math.abs(event.clientX - (rect.left + rect.width * split / 100)) <= (event.pointerType === 'touch' ? 50 : 32);
  }

  function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function beginPinch() {
    const values = [...pointers.values()];
    if (values.length < 2 || (!metrics && !refreshMetrics())) return false;
    const [a, b] = values;
    const rect = compare.getBoundingClientRect();
    const cx = (a.x + b.x) / 2 - (rect.left + rect.width / 2);
    const cy = (a.y + b.y) / 2 - (rect.top + rect.height / 2);
    pinch = {
      distance:Math.max(1, distance(a, b)),
      scale:view.scale,
      anchorX:(cx - view.x) / view.scale,
      anchorY:(cy - view.y) / view.scale
    };
    pan = null;
    fitLocked = false;
    compare.classList.add('video-optimize-panning');
    return true;
  }

  function updatePinch() {
    const values = [...pointers.values()];
    if (!pinch || values.length < 2) return;
    const [a, b] = values;
    const rect = compare.getBoundingClientRect();
    const cx = (a.x + b.x) / 2 - (rect.left + rect.width / 2);
    const cy = (a.y + b.y) / 2 - (rect.top + rect.height / 2);
    const next = snapNative(view.scale, pinch.scale * distance(a, b) / pinch.distance);
    view.scale = next;
    view.x = cx - pinch.anchorX * next;
    view.y = cy - pinch.anchorY * next;
    clampPan();
    drawPair();
  }

  compare.addEventListener('pointerdown', event => {
    if (!active() || dividerHit(event)) return;
    pointers.set(event.pointerId, { x:event.clientX, y:event.clientY });
    try { compare.setPointerCapture(event.pointerId); } catch {}
    if (pointers.size >= 2) beginPinch();
    else pan = { id:event.pointerId, startX:event.clientX, startY:event.clientY, x:view.x, y:view.y, active:false };
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  compare.addEventListener('pointermove', event => {
    const point = pointers.get(event.pointerId);
    if (!point) return;
    point.x = event.clientX;
    point.y = event.clientY;
    if (pointers.size >= 2) {
      if (!pinch) beginPinch();
      updatePinch();
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (!pan || pan.id !== event.pointerId) return;
    const dx = event.clientX - pan.startX;
    const dy = event.clientY - pan.startY;
    if (!pan.active && Math.hypot(dx, dy) < PAN_START) return;
    if (!pan.active) {
      pan.active = true;
      fitLocked = false;
      compare.classList.add('video-optimize-panning');
    }
    view.x = pan.x + dx;
    view.y = pan.y + dy;
    clampPan();
    drawPair();
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  function finishPointer(event) {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    try { compare.releasePointerCapture(event.pointerId); } catch {}
    if (pan?.id === event.pointerId) pan = null;
    if (pointers.size < 2) pinch = null;
    if (!pointers.size) compare.classList.remove('video-optimize-panning');
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  compare.addEventListener('pointerup', finishPointer, true);
  compare.addEventListener('pointercancel', finishPointer, true);

  // The base divider updates --split. Repaint the already-matched frame pair;
  // no decoder access or synchronization work is needed for slider movement.
  new MutationObserver(() => {
    if (active()) drawPair();
  }).observe(compare, { attributes:true, attributeFilter:['style'] });

  function captureSettingState(event) {
    if (!active() || restoring || !optimized.currentSrc) return;
    const target = event.target;
    if (!target?.closest) return;
    if (target.closest('[data-s]')) {
      pendingRestore = null;
      return;
    }
    if (!target.closest('[data-value],[data-q],[data-e]')) return;
    pendingRestore = {
      relative:Number(optimized.currentTime) || 0,
      playing:!optimized.paused && play?.dataset.playing === '1',
      oldSrc:optimized.currentSrc || optimized.src || ''
    };
  }

  controls?.addEventListener('click', captureSettingState, true);
  controls?.addEventListener('change', captureSettingState, true);

  function waitForSeek(video, timeout = 1200) {
    return new Promise(resolve => {
      if (!video.seeking) return resolve();
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        video.removeEventListener('seeked', finish);
        resolve();
      };
      video.addEventListener('seeked', finish, { once:true });
      setTimeout(finish, timeout);
    });
  }

  async function restoreSettingState() {
    if (!pendingRestore || restoring || !active()) return;
    const currentSrc = optimized.currentSrc || optimized.src || '';
    if (!currentSrc || currentSrc === pendingRestore.oldSrc) return;
    const wanted = pendingRestore;
    pendingRestore = null;
    restoring = true;
    try {
      optimized.pause();
      original.pause();
      captureOffset(true);
      const duration = Math.max(.001, Number(optimized.duration) || 6);
      const relative = clamp(wanted.relative, 0, Math.max(0, duration - .001));
      try { optimized.currentTime = relative; } catch {}
      try { original.currentTime = Math.max(0, sourceOffset + relative); } catch {}
      await Promise.all([waitForSeek(optimized), waitForSeek(original)]);
      captureOffset(true);
      startWatchers(true);
      if (wanted.playing && active()) {
        await Promise.allSettled([original.play(), optimized.play()]);
      }
    } finally {
      restoring = false;
    }
  }

  optimized.addEventListener('loadedmetadata', () => {
    const src = optimized.currentSrc || optimized.src || '';
    if (src && src !== lastPreviewSrc) {
      lastPreviewSrc = src;
      sourceOffset = NaN;
      startWatchers(true);
    }
    if (fitLocked) fitView();
    else {
      refreshMetrics();
      clampPan();
      drawPair();
    }
  });

  original.addEventListener('loadedmetadata', () => {
    if (!Number.isFinite(sourceOffset)) captureOffset();
    if (fitLocked) fitView();
  });

  optimized.addEventListener('playing', () => {
    if (!Number.isFinite(sourceOffset)) captureOffset(true);
    if (pendingRestore && (optimized.currentSrc || optimized.src || '') !== pendingRestore.oldSrc) {
      setTimeout(() => restoreSettingState().catch(() => {}), 0);
    }
  });

  for (const video of [original, optimized]) {
    video.addEventListener('seeked', () => {
      if (!active()) return;
      if (!Number.isFinite(sourceOffset) || Number(optimized.currentTime) < .12) captureOffset(true);
    });
  }

  window.addEventListener('mochimono:optimize-open', () => {
    if (!active()) return;
    sourceOffset = NaN;
    fitLocked = true;
    metrics = null;
    view = { scale:1, x:0, y:0 };
    clearFrames(false);
    startWatchers(false);
    updateZoomLabel();
  });

  window.addEventListener('mochimono:optimize-close', () => {
    watcherGeneration++;
    sourceOffset = NaN;
    pendingRestore = null;
    restoring = false;
    clearFrames(false);
    metrics = null;
    fitLocked = true;
    view = { scale:1, x:0, y:0 };
    pan = null;
    pinch = null;
    pointers.clear();
    compare.classList.remove('video-optimize-panning');
    updateZoomLabel();
  });

  window.addEventListener('resize', () => {
    if (!active() || !refreshMetrics()) return;
    if (fitLocked) {
      view.scale = metrics.fit;
      view.x = 0;
      view.y = 0;
    }
    clampPan();
    drawPair();
  }, { passive:true });

  window.mochimonoVideoOptimizeZoom = {
    state:() => ({ ...view, fitScale:metrics?.fit || 1, native:true }),
    set(next = {}) {
      if (!refreshMetrics()) return;
      if (next.fit === true || !Number.isFinite(Number(next.scale))) {
        fitView();
        return;
      }
      fitLocked = false;
      view.scale = clamp(Number(next.scale), MIN_SCALE, MAX_SCALE);
      view.x = Number(next.x) || 0;
      view.y = Number(next.y) || 0;
      clampPan();
      drawPair();
    },
    reset:fitView
  };
}
