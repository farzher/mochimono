const viewer = document.querySelector('#viewer');
const compare = document.querySelector('.video-optimize-compare');
const original = compare?.querySelector('[data-o]');
const optimized = compare?.querySelector('[data-a]');
const playhead = document.querySelector('[data-playhead]');
const time = document.querySelector('[data-time]');

if (viewer && original && optimized && playhead && time) {
  // Loaded after live-settings so this is the one transport entry point for
  // scrubbing. The wrapped handler still owns pending-preview bookkeeping and
  // the actual paired seek; this layer only schedules valid frame positions.
  const seekHandler = playhead.oninput;
  let frame = 0;
  let scrubbing = false;
  let targetFps = 0;
  let metadataSerial = 0;
  let seekFrame = 0;
  let seekRunning = false;
  let queuedPoint = null;
  let lastRequestedPoint = NaN;

  const active = () => viewer.classList.contains('video-optimize-active');
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const clock = value => {
    const seconds = Math.max(0, Number(value) || 0);
    const h = Math.floor(seconds / 3600);
    const m = Math.floor(seconds % 3600 / 60);
    const s = Math.floor(seconds % 60);
    return h ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${m}:${String(s).padStart(2,'0')}`;
  };

  function duration() {
    return Number.isFinite(optimized.duration) && optimized.duration > 0
      ? optimized.duration
      : Math.max(.01, Number(playhead.max) || 6);
  }

  function lowFpsStep() {
    // At 15 fps and below, arbitrary millisecond seeks mostly address frames
    // that do not exist. Snap decoder work to the actual encoded frame grid.
    return targetFps > 0 && targetFps <= 15 ? 1 / targetFps : 0;
  }

  function snapToFrame(value) {
    const length = duration();
    const step = lowFpsStep();
    const wanted = clamp(Number(value) || 0, 0, length);
    if (!step) return wanted;
    // A 6.0 s, 5 fps sample normally has frames through 5.8 s; avoid seeking
    // exactly to the media end, which puts the video in ended state.
    const lastFrame = Math.max(0, Math.floor((length - 1e-6) / step) * step);
    return clamp(Math.round(wanted / step) * step, 0, lastFrame);
  }

  function update() {
    if (!active()) return;
    const length = duration();
    const current = clamp(Number(optimized.currentTime) || 0, 0, length);
    playhead.max = String(length);
    if (!scrubbing) playhead.value = String(current);
    time.textContent = `${clock(scrubbing ? Number(playhead.value) || current : current)} / ${clock(length)}`;
  }

  function loop() {
    frame = 0;
    if (!active()) return;
    update();
    frame = requestAnimationFrame(loop);
  }

  function start() {
    if (frame || !active()) return;
    frame = requestAnimationFrame(loop);
  }

  function stop() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  }

  function waitForSeek(video, timeout = 800) {
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

  async function runQueuedSeek() {
    if (seekRunning || queuedPoint == null || !active()) return;
    seekRunning = true;
    try {
      while (queuedPoint != null && active()) {
        const point = queuedPoint;
        queuedPoint = null;
        const visibleValue = playhead.value;
        playhead.value = String(point);
        let result;
        try { result = seekHandler?.call(playhead); }
        finally {
          // Keep the thumb under the pointer while dragging; only decoder work
          // is quantized. On release update() shows the resolved real frame.
          if (scrubbing) playhead.value = visibleValue;
        }
        await Promise.resolve(result).catch(() => {});
        await Promise.all([waitForSeek(optimized), waitForSeek(original)]);
      }
    } finally {
      seekRunning = false;
      if (!scrubbing) update();
      if (queuedPoint != null && active()) scheduleQueuedSeek();
    }
  }

  function scheduleQueuedSeek() {
    if (seekFrame || seekRunning) return;
    seekFrame = requestAnimationFrame(() => {
      seekFrame = 0;
      runQueuedSeek().catch(() => {});
    });
  }

  async function refreshPreviewMetadata() {
    const id = optimized.dataset.id || '';
    const serial = ++metadataSerial;
    targetFps = 0;
    lastRequestedPoint = NaN;
    queuedPoint = null;
    if (!id) return;
    try {
      const response = await fetch(`/api/video-optimize/status?id=${encodeURIComponent(id)}`, { cache:'no-store' });
      if (!response.ok) return;
      const data = await response.json();
      if (serial !== metadataSerial || id !== optimized.dataset.id) return;
      targetFps = Math.max(0, Number(data.targetFps) || Number(data.fps) || 0);
    } catch {}
  }

  playhead.oninput = () => {
    scrubbing = true;
    const step = lowFpsStep();
    if (!step) return seekHandler?.call(playhead);

    const point = snapToFrame(playhead.value);
    // Dragging across many millisecond positions inside the same 200 ms frame
    // should not issue the same expensive decoder seek over and over.
    if (Number.isFinite(lastRequestedPoint) && Math.abs(point - lastRequestedPoint) < step * .1) return;
    lastRequestedPoint = point;
    queuedPoint = point;
    scheduleQueuedSeek();
  };

  playhead.addEventListener('pointerdown', () => { scrubbing = true; });
  playhead.addEventListener('input', () => {
    scrubbing = true;
    const length = duration();
    time.textContent = `${clock(clamp(Number(playhead.value) || 0, 0, length))} / ${clock(length)}`;
  });
  const finishScrub = () => {
    scrubbing = false;
    if (!seekRunning && queuedPoint == null) requestAnimationFrame(update);
  };
  playhead.addEventListener('pointerup', finishScrub);
  playhead.addEventListener('pointercancel', finishScrub);
  playhead.addEventListener('change', finishScrub);
  playhead.addEventListener('blur', finishScrub);

  optimized.addEventListener('loadedmetadata', () => {
    update();
    refreshPreviewMetadata().catch(() => {});
  });
  optimized.addEventListener('durationchange', update);
  optimized.addEventListener('seeked', update);
  optimized.addEventListener('playing', start);
  optimized.addEventListener('pause', update);

  new MutationObserver(() => refreshPreviewMetadata().catch(() => {})).observe(optimized, {
    attributes:true,
    attributeFilter:['data-id']
  });

  window.addEventListener('mochimono:optimize-open', () => {
    scrubbing = false;
    targetFps = 0;
    queuedPoint = null;
    lastRequestedPoint = NaN;
    update();
    refreshPreviewMetadata().catch(() => {});
    start();
  });
  window.addEventListener('mochimono:optimize-close', () => {
    scrubbing = false;
    targetFps = 0;
    queuedPoint = null;
    lastRequestedPoint = NaN;
    metadataSerial++;
    if (seekFrame) cancelAnimationFrame(seekFrame);
    seekFrame = 0;
    stop();
  });
}
