const viewer = document.querySelector('#viewer');
const compare = document.querySelector('.video-optimize-compare');
const canvas = compare?.querySelector('[data-canvas]');
const original = compare?.querySelector('[data-o]');
const optimized = compare?.querySelector('[data-a]');
const controls = document.querySelector('[data-controls]');
const play = document.querySelector('[data-play]');

if (viewer && compare && canvas && original && optimized) {
  const ctx = canvas.getContext('2d', { alpha:false });
  const previousFillRect = ctx.fillRect.bind(ctx);
  const previousDrawImage = ctx.drawImage.bind(ctx);
  let suppressComposite = false;
  let sourceOffset = NaN;
  let originalMediaTime = NaN;
  let optimizedMediaTime = NaN;
  let originalFrameDuration = 1 / 30;
  let optimizedFrameDuration = 1 / 30;
  let previousOriginalMediaTime = NaN;
  let previousOptimizedMediaTime = NaN;
  let watcherGeneration = 0;
  let syncInFlight = false;
  let restoring = false;
  let pausedAlignTimer = 0;
  let pendingRestore = null;
  let lastPreviewSrc = '';

  const active = () => viewer.classList.contains('video-optimize-active');
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function frameTolerance() {
    return Math.max(.006, Math.max(originalFrameDuration, optimizedFrameDuration) * .58);
  }

  function relativeDrift() {
    if (!Number.isFinite(sourceOffset) || !Number.isFinite(originalMediaTime) || !Number.isFinite(optimizedMediaTime)) return Infinity;
    return (originalMediaTime - sourceOffset) - optimizedMediaTime;
  }

  function framesAligned() {
    return active() && Number.isFinite(sourceOffset) && Number.isFinite(originalMediaTime) && Number.isFinite(optimizedMediaTime) && Math.abs(relativeDrift()) <= frameTolerance();
  }

  function updateFrame(kind, value) {
    if (!Number.isFinite(value)) return;
    if (kind === 'original') {
      if (Number.isFinite(previousOriginalMediaTime)) {
        const delta = Math.abs(value - previousOriginalMediaTime);
        if (delta >= .004 && delta <= .15) originalFrameDuration = delta;
      }
      previousOriginalMediaTime = value;
      originalMediaTime = value;
      return;
    }
    if (Number.isFinite(previousOptimizedMediaTime)) {
      const delta = Math.abs(value - previousOptimizedMediaTime);
      if (delta >= .004 && delta <= .15) optimizedFrameDuration = delta;
    }
    previousOptimizedMediaTime = value;
    optimizedMediaTime = value;
  }

  function captureOffset(force = false) {
    if (!active() || original.readyState < 1 || optimized.readyState < 1) return false;
    const next = Number(original.currentTime) - Number(optimized.currentTime);
    if (!Number.isFinite(next)) return false;
    if (force || !Number.isFinite(sourceOffset)) sourceOffset = next;
    return Number.isFinite(sourceOffset);
  }

  function correctPlaybackSync() {
    if (!active() || restoring || syncInFlight || original.paused || optimized.paused) return;
    if (!Number.isFinite(sourceOffset) && !captureOffset()) return;
    if (!Number.isFinite(optimizedMediaTime) || !Number.isFinite(originalMediaTime)) return;
    const drift = relativeDrift();
    const tolerance = frameTolerance();
    if (Math.abs(drift) > tolerance) {
      syncInFlight = true;
      original.playbackRate = 1;
      try { original.currentTime = Math.max(0, sourceOffset + optimizedMediaTime); } catch {}
      const clear = () => {
        syncInFlight = false;
        original.removeEventListener('seeked', clear);
      };
      original.addEventListener('seeked', clear, { once:true });
      setTimeout(clear, 180);
      return;
    }
    original.playbackRate = clamp(1 - drift * 1.8, .94, 1.06);
  }

  // Both the base comparison renderer and the zoom renderer clear the whole
  // canvas before drawing the two live videos. Refuse the whole paint whenever
  // their actually-presented frame timestamps do not correspond. The previous
  // matched composite remains visible instead of ever exposing two time points.
  ctx.fillRect = function(...args) {
    const fullPaint = active() && args.length === 4 && Math.abs(Number(args[0])) < .01 && Math.abs(Number(args[1])) < .01 && Number(args[2]) >= (compare.clientWidth || 1) - 1 && Number(args[3]) >= (compare.clientHeight || 1) - 1;
    if (fullPaint && !framesAligned()) {
      suppressComposite = true;
      correctPlaybackSync();
      return;
    }
    suppressComposite = false;
    return previousFillRect(...args);
  };

  ctx.drawImage = function(...args) {
    if (suppressComposite && (args[0] === original || args[0] === optimized)) return;
    return previousDrawImage(...args);
  };

  function requestRedraw() {
    const zoom = window.mochimonoVideoOptimizeZoom;
    const state = zoom?.state?.();
    if (zoom?.set && state) zoom.set(state);
  }

  function startFrameWatchers() {
    const generation = ++watcherGeneration;
    previousOriginalMediaTime = NaN;
    previousOptimizedMediaTime = NaN;
    originalMediaTime = NaN;
    optimizedMediaTime = NaN;

    const watchOriginal = (_, metadata) => {
      if (generation !== watcherGeneration) return;
      updateFrame('original', Number(metadata?.mediaTime ?? original.currentTime));
      original.requestVideoFrameCallback?.(watchOriginal);
    };
    const watchOptimized = (_, metadata) => {
      if (generation !== watcherGeneration) return;
      updateFrame('optimized', Number(metadata?.mediaTime ?? optimized.currentTime));
      correctPlaybackSync();
      optimized.requestVideoFrameCallback?.(watchOptimized);
    };

    if (original.requestVideoFrameCallback) original.requestVideoFrameCallback(watchOriginal);
    if (optimized.requestVideoFrameCallback) optimized.requestVideoFrameCallback(watchOptimized);
  }

  function waitForSeek(video, timeout = 1200) {
    return new Promise(resolve => {
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

  async function seekPresented(video, time) {
    const wanted = Math.max(0, Number(time) || 0);
    let resolveFrame;
    const frame = new Promise(resolve => { resolveFrame = resolve; });
    let frameDone = false;
    const finishFrame = value => {
      if (frameDone) return;
      frameDone = true;
      resolveFrame(Number(value) || Number(video.currentTime) || 0);
    };
    if (video.requestVideoFrameCallback) {
      video.requestVideoFrameCallback((_, metadata) => finishFrame(metadata?.mediaTime));
    } else {
      setTimeout(() => finishFrame(video.currentTime), 0);
    }
    const seek = waitForSeek(video);
    try { video.currentTime = wanted; } catch {}
    await seek;
    const timeout = setTimeout(() => finishFrame(video.currentTime), 500);
    const presented = await frame;
    clearTimeout(timeout);
    return presented;
  }

  async function seekAlignedPair(relative) {
    const duration = Math.max(.001, Number(optimized.duration) || 6);
    let optimizedPoint = clamp(Number(relative) || 0, 0, Math.max(0, duration - .001));
    optimizedMediaTime = await seekPresented(optimized, optimizedPoint);
    originalMediaTime = await seekPresented(original, sourceOffset + optimizedMediaTime);

    // A seek can land on opposite sides of a frame boundary. Resolve against
    // the frame Original actually presented, then ask Original for that exact
    // compressed timestamp again. This converges on the same visual moment for
    // equal-rate streams and the nearest shared frame for reduced-FPS previews.
    for (let attempt = 0; attempt < 2 && Math.abs(relativeDrift()) > frameTolerance(); attempt++) {
      optimizedPoint = clamp(originalMediaTime - sourceOffset, 0, Math.max(0, duration - .001));
      optimizedMediaTime = await seekPresented(optimized, optimizedPoint);
      originalMediaTime = await seekPresented(original, sourceOffset + optimizedMediaTime);
    }
    return framesAligned();
  }

  async function alignPausedFrame() {
    clearTimeout(pausedAlignTimer);
    if (!active() || restoring || syncInFlight || !optimized.paused) return;
    if (!Number.isFinite(sourceOffset) && !captureOffset()) return;
    syncInFlight = true;
    try {
      original.pause();
      optimized.pause();
      original.playbackRate = 1;
      const master = Number.isFinite(optimizedMediaTime) ? optimizedMediaTime : Number(optimized.currentTime) || 0;
      if (await seekAlignedPair(master)) requestRedraw();
    } finally {
      syncInFlight = false;
    }
  }

  function schedulePausedAlignment(delay = 45) {
    clearTimeout(pausedAlignTimer);
    pausedAlignTimer = setTimeout(() => alignPausedFrame().catch(() => {}), delay);
  }

  function snapshotBeforeSettingChange(event) {
    if (!active() || restoring || !optimized.currentSrc || !Number.isFinite(sourceOffset)) return;
    const target = event.target;
    if (!target?.closest) return;
    if (target.closest('[data-s]')) {
      pendingRestore = null;
      return;
    }
    if (target.closest('[data-play],[data-playhead],[data-keep],[data-replace],[data-close-right],[data-close-left]')) return;
    if (!target.closest('[data-value],[data-q],[data-e]')) return;
    const relative = Number.isFinite(optimizedMediaTime) ? optimizedMediaTime : Number(optimized.currentTime) || 0;
    pendingRestore = {
      sourceTime:sourceOffset + relative,
      playing:!optimized.paused && play?.dataset.playing === '1',
      oldSrc:optimized.currentSrc || optimized.src || ''
    };
  }

  async function restoreAfterSettingChange() {
    if (!pendingRestore || restoring || !active()) return;
    const currentSrc = optimized.currentSrc || optimized.src || '';
    if (!currentSrc || currentSrc === pendingRestore.oldSrc) return;
    const wanted = pendingRestore;
    pendingRestore = null;
    restoring = true;
    syncInFlight = true;
    try {
      optimized.pause();
      original.pause();
      original.playbackRate = 1;
      if (!Number.isFinite(sourceOffset) && !captureOffset(true)) return;
      const duration = Math.max(.001, Number(optimized.duration) || 6);
      const relative = clamp(wanted.sourceTime - sourceOffset, 0, Math.max(0, duration - .001));
      if (await seekAlignedPair(relative)) requestRedraw();
      if (wanted.playing && active()) {
        await Promise.allSettled([original.play(), optimized.play()]);
      } else {
        original.pause();
        optimized.pause();
        schedulePausedAlignment(0);
      }
    } finally {
      restoring = false;
      syncInFlight = false;
    }
  }

  controls?.addEventListener('click', snapshotBeforeSettingChange, true);
  controls?.addEventListener('change', snapshotBeforeSettingChange, true);

  original.addEventListener('seeking', () => { originalMediaTime = NaN; });
  optimized.addEventListener('seeking', () => { optimizedMediaTime = NaN; });

  for (const video of [original, optimized]) video.addEventListener('seeked', () => {
    if (!active()) return;
    if (!syncInFlight && !restoring && (!Number.isFinite(sourceOffset) || Number(optimized.currentTime) < .15)) captureOffset(true);
    if (optimized.paused) schedulePausedAlignment();
  });

  optimized.addEventListener('loadedmetadata', () => {
    const src = optimized.currentSrc || optimized.src || '';
    if (src !== lastPreviewSrc) {
      lastPreviewSrc = src;
      sourceOffset = NaN;
      originalMediaTime = NaN;
      optimizedMediaTime = NaN;
      startFrameWatchers();
    }
  });

  optimized.addEventListener('playing', () => {
    if (!Number.isFinite(sourceOffset)) captureOffset(true);
    if (pendingRestore && (optimized.currentSrc || optimized.src || '') !== pendingRestore.oldSrc) {
      setTimeout(() => restoreAfterSettingChange().catch(() => {}), 0);
    }
  });

  optimized.addEventListener('pause', () => {
    if (active() && !optimized.ended && !restoring) schedulePausedAlignment();
  });

  window.addEventListener('mochimono:optimize-open', () => {
    if (!active()) return;
    sourceOffset = NaN;
    originalMediaTime = NaN;
    optimizedMediaTime = NaN;
    pendingRestore = null;
    startFrameWatchers();
  });
  window.addEventListener('mochimono:optimize-close', () => {
    watcherGeneration++;
    clearTimeout(pausedAlignTimer);
    sourceOffset = NaN;
    originalMediaTime = NaN;
    optimizedMediaTime = NaN;
    pendingRestore = null;
    restoring = false;
    syncInFlight = false;
    suppressComposite = false;
  });
}
