const viewer = document.querySelector('#viewer');
const compare = document.querySelector('.video-optimize-compare');
const canvas = compare?.querySelector('[data-canvas]');
const original = compare?.querySelector('[data-o]');
const optimized = compare?.querySelector('[data-a]');
const controls = document.querySelector('[data-controls]');
const playhead = document.querySelector('[data-playhead]');
const play = document.querySelector('[data-play]');

if (viewer && compare && canvas && original && optimized) {
  const ctx = canvas.getContext('2d', { alpha:false });
  const previousFillRect = ctx.fillRect.bind(ctx);
  const previousDrawImage = ctx.drawImage.bind(ctx);

  let watcherGeneration = 0;
  let sessionGeneration = 0;
  let session = null;
  let originalFrame = NaN;
  let optimizedFrame = NaN;
  let previousOriginalFrame = NaN;
  let previousOptimizedFrame = NaN;
  let originalFrameDuration = 1 / 30;
  let optimizedFrameDuration = 1 / 30;
  let suppressComposite = false;
  let lastGoodPaint = 0;
  let alignTimer = 0;
  let alignBusy = false;
  let pendingRestore = null;
  let restoreTimer = 0;
  let driftTimer = 0;
  let lastPreviewId = '';

  const active = () => viewer.classList.contains('video-optimize-active');
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function frameTolerance() {
    const sourceDuration = session?.fps ? 1 / session.fps : originalFrameDuration;
    const targetDuration = session?.targetFps ? 1 / session.targetFps : optimizedFrameDuration;
    return Math.max(.006, Math.min(sourceDuration || 1 / 30, targetDuration || 1 / 30) * .72);
  }

  function relativeDrift() {
    if (!session || !Number.isFinite(originalFrame) || !Number.isFinite(optimizedFrame)) return Infinity;
    return (originalFrame - session.sampleStart) - optimizedFrame;
  }

  function framesAligned() {
    return Number.isFinite(relativeDrift()) && Math.abs(relativeDrift()) <= frameTolerance();
  }

  function updateFrame(which, value) {
    if (!Number.isFinite(value)) return;
    if (which === 'original') {
      if (Number.isFinite(previousOriginalFrame)) {
        const delta = Math.abs(value - previousOriginalFrame);
        if (delta >= .003 && delta <= .2) originalFrameDuration = delta;
      }
      previousOriginalFrame = value;
      originalFrame = value;
    } else {
      if (Number.isFinite(previousOptimizedFrame)) {
        const delta = Math.abs(value - previousOptimizedFrame);
        if (delta >= .003 && delta <= .2) optimizedFrameDuration = delta;
      }
      previousOptimizedFrame = value;
      optimizedFrame = value;
    }
    if (framesAligned()) requestRedraw();
  }

  function requestRedraw() {
    const zoom = window.mochimonoVideoOptimizeZoom;
    const state = zoom?.state?.();
    if (zoom?.set && state) zoom.set(state);
  }

  // The base player repaints whenever the compressed decoder presents a frame.
  // If Original is only a callback behind, keep the previous matched composite
  // for at most a tiny fraction of a second and repaint as soon as Original's
  // matching frame arrives. Crucially, this never seeks during playback.
  ctx.fillRect = function(...args) {
    const fullPaint = active() && args.length === 4 &&
      Math.abs(Number(args[0])) < .01 && Math.abs(Number(args[1])) < .01 &&
      Number(args[2]) >= (compare.clientWidth || 1) - 1 &&
      Number(args[3]) >= (compare.clientHeight || 1) - 1;

    if (fullPaint && session && Number.isFinite(originalFrame) && Number.isFinite(optimizedFrame) && !framesAligned()) {
      const now = performance.now();
      // Never turn a temporary decoder scheduling difference into visible
      // freezing. One frame may be held briefly; after 45ms we paint anyway.
      if (now - lastGoodPaint < 45) {
        suppressComposite = true;
        return;
      }
    }

    suppressComposite = false;
    if (fullPaint) lastGoodPaint = performance.now();
    return previousFillRect(...args);
  };

  ctx.drawImage = function(...args) {
    if (suppressComposite && (args[0] === original || args[0] === optimized)) return;
    return previousDrawImage(...args);
  };

  function startFrameWatchers() {
    const generation = ++watcherGeneration;
    previousOriginalFrame = NaN;
    previousOptimizedFrame = NaN;
    originalFrame = NaN;
    optimizedFrame = NaN;

    const watchOriginal = (_, metadata) => {
      if (generation !== watcherGeneration) return;
      updateFrame('original', Number(metadata?.mediaTime ?? original.currentTime));
      original.requestVideoFrameCallback?.(watchOriginal);
    };
    const watchOptimized = (_, metadata) => {
      if (generation !== watcherGeneration) return;
      updateFrame('optimized', Number(metadata?.mediaTime ?? optimized.currentTime));
      optimized.requestVideoFrameCallback?.(watchOptimized);
    };

    if (original.requestVideoFrameCallback) original.requestVideoFrameCallback(watchOriginal);
    if (optimized.requestVideoFrameCallback) optimized.requestVideoFrameCallback(watchOptimized);
  }

  function waitForSeek(video, timeout = 900) {
    return new Promise(resolve => {
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        video.removeEventListener('seeked', done);
        resolve();
      };
      video.addEventListener('seeked', done, { once:true });
      setTimeout(done, timeout);
    });
  }

  function seekPresented(video, time) {
    const wanted = Math.max(0, Number(time) || 0);
    return new Promise(async resolve => {
      let frameResolved = false;
      let frameValue = NaN;
      let finishFrame;
      const frameReady = new Promise(done => { finishFrame = done; });
      const acceptFrame = value => {
        if (frameResolved) return;
        frameResolved = true;
        frameValue = Number(value);
        finishFrame();
      };

      if (video.requestVideoFrameCallback) {
        video.requestVideoFrameCallback((_, metadata) => acceptFrame(metadata?.mediaTime));
      }

      const seeked = waitForSeek(video);
      try { video.currentTime = wanted; } catch {}
      await seeked;
      if (!video.requestVideoFrameCallback) acceptFrame(video.currentTime);
      const fallback = setTimeout(() => acceptFrame(video.currentTime), 240);
      await frameReady;
      clearTimeout(fallback);
      resolve(Number.isFinite(frameValue) ? frameValue : Number(video.currentTime) || wanted);
    });
  }

  async function alignAt(relative, resume = false) {
    if (!active() || !session || alignBusy || original.readyState < 1 || optimized.readyState < 1) return;
    alignBusy = true;
    clearTimeout(alignTimer);
    try {
      original.pause();
      optimized.pause();
      original.playbackRate = 1;

      const duration = Math.max(.001, Number(session.sampleDuration) || Number(optimized.duration) || 6);
      const point = clamp(Number(relative) || 0, 0, Math.max(0, duration - .001));

      // Compressed is the timeline master. Ask it which frame it actually
      // presented, then seek Original once to that exact absolute source time.
      optimizedFrame = await seekPresented(optimized, point);
      originalFrame = await seekPresented(original, session.sampleStart + optimizedFrame);

      // Browser seeking can resolve to the adjacent source frame on an exact
      // boundary. One retry against the compressed frame is enough; never loop.
      if (!framesAligned()) {
        originalFrame = await seekPresented(original, session.sampleStart + optimizedFrame + .0001);
      }

      suppressComposite = false;
      lastGoodPaint = performance.now();
      requestRedraw();

      if (resume && active()) {
        await Promise.allSettled([original.play(), optimized.play()]);
      } else {
        original.pause();
        optimized.pause();
      }
    } finally {
      alignBusy = false;
    }
  }

  function schedulePausedAlignment(delay = 28) {
    clearTimeout(alignTimer);
    alignTimer = setTimeout(() => {
      if (active() && optimized.paused && !optimized.ended) alignAt(optimized.currentTime, false).catch(() => {});
    }, delay);
  }

  async function readSession(id) {
    const generation = ++sessionGeneration;
    try {
      const response = await fetch(`/api/video-optimize/status?id=${encodeURIComponent(id)}`, { cache:'no-store' });
      const data = await response.json();
      if (!response.ok) throw Error(data.error || response.statusText);
      if (generation !== sessionGeneration || id !== optimized.dataset.id) return null;
      session = {
        id,
        sampleStart:Number(data.sampleStart) || 0,
        sampleDuration:Number(data.sampleDuration) || Number(optimized.duration) || 6,
        fps:Number(data.fps) || 30,
        targetFps:Number(data.targetFps) || Number(data.fps) || 30
      };
      return session;
    } catch {
      if (generation === sessionGeneration) session = null;
      return null;
    }
  }

  function captureSettingState(event) {
    if (!active() || !session || !optimized.currentSrc || alignBusy) return;
    const target = event.target;
    if (!target?.closest) return;
    if (target.closest('[data-s]')) {
      pendingRestore = null;
      return;
    }
    if (!target.closest('[data-value],[data-q],[data-e]')) return;
    pendingRestore = {
      absoluteTime:session.sampleStart + (Number(optimized.currentTime) || 0),
      playing:!optimized.paused && play?.dataset.playing === '1',
      oldId:optimized.dataset.id || ''
    };
  }

  async function restoreSettingState() {
    clearTimeout(restoreTimer);
    if (!pendingRestore || !session || pendingRestore.oldId === session.id || !active()) return;
    const restore = pendingRestore;
    pendingRestore = null;
    const relative = clamp(restore.absoluteTime - session.sampleStart, 0, Math.max(0, session.sampleDuration - .001));
    await alignAt(relative, restore.playing);
  }

  controls?.addEventListener('pointerdown', captureSettingState, true);
  controls?.addEventListener('change', captureSettingState, true);

  optimized.addEventListener('loadedmetadata', async () => {
    const id = optimized.dataset.id || '';
    if (!id || id === lastPreviewId) return;
    lastPreviewId = id;
    session = null;
    startFrameWatchers();
    await readSession(id);
    if (!active() || id !== optimized.dataset.id) return;
    if (pendingRestore && pendingRestore.oldId !== id) {
      // Base installPreview starts the new sample at zero. Restore after that
      // initial seek/play settles, while preventing a paused preview from
      // running away in the meantime.
      restoreTimer = setTimeout(() => restoreSettingState().catch(() => {}), 55);
    } else {
      schedulePausedAlignment(45);
    }
  });

  optimized.addEventListener('play', () => {
    if (pendingRestore && pendingRestore.playing === false && pendingRestore.oldId !== optimized.dataset.id) {
      queueMicrotask(() => {
        optimized.pause();
        original.pause();
      });
    }
  });

  optimized.addEventListener('pause', () => {
    original.playbackRate = 1;
    if (active() && session && !optimized.ended && !alignBusy) schedulePausedAlignment();
  });

  playhead?.addEventListener('change', () => schedulePausedAlignment(0));
  playhead?.addEventListener('pointerup', () => schedulePausedAlignment(0));

  // Over a six-second preview the media clocks should naturally remain close.
  // A tiny rate nudge corrects scheduler drift without ever seeking mid-playback.
  driftTimer = setInterval(() => {
    if (!active() || !session || alignBusy || original.paused || optimized.paused) return;
    const drift = (Number(original.currentTime) - session.sampleStart) - Number(optimized.currentTime);
    const tolerance = frameTolerance();
    if (!Number.isFinite(drift) || Math.abs(drift) <= tolerance * .45) {
      original.playbackRate = 1;
      return;
    }
    original.playbackRate = clamp(1 - drift * .55, .985, 1.015);
  }, 120);

  window.addEventListener('mochimono:optimize-open', () => {
    if (!active()) return;
    session = null;
    pendingRestore = null;
    lastPreviewId = '';
    startFrameWatchers();
  });

  window.addEventListener('mochimono:optimize-close', () => {
    watcherGeneration++;
    sessionGeneration++;
    clearTimeout(alignTimer);
    clearTimeout(restoreTimer);
    session = null;
    pendingRestore = null;
    lastPreviewId = '';
    alignBusy = false;
    suppressComposite = false;
    original.playbackRate = 1;
  });

  window.addEventListener('beforeunload', () => clearInterval(driftTimer), { once:true });
}
