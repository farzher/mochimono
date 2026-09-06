const viewer = document.querySelector('#viewer');
const compare = document.querySelector('.video-optimize-compare');
const original = compare?.querySelector('[data-o]');
const optimized = compare?.querySelector('[data-a]');
const controls = document.querySelector('[data-controls]');
const play = document.querySelector('[data-play]');
const playIcon = document.querySelector('[data-play-icon]');
const playhead = document.querySelector('[data-playhead]');

if (viewer && original && optimized && controls && play && playIcon && playhead) {
  const nativeOptimizedPause = optimized.pause.bind(optimized);
  const nativeOriginalPause = original.pause.bind(original);
  const nativeOptimizedPlay = optimized.play.bind(optimized);
  const nativeOriginalPlay = original.play.bind(original);

  let pending = null;
  let suppressOptimizedPause = false;
  let suppressOriginalPause = false;
  let restoreSerial = 0;

  const active = () => viewer.classList.contains('video-optimize-active');
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const currentSrc = () => optimized.currentSrc || optimized.src || '';
  const duration = () => Number.isFinite(optimized.duration) && optimized.duration > 0 ? optimized.duration : Math.max(.01, Number(playhead.max) || 6);
  const sourceOffset = () => Number(original.currentTime) - Number(optimized.currentTime);

  function setPlaying(value) {
    play.dataset.playing = value ? '1' : '0';
    playIcon.textContent = value ? '❚❚' : '▶';
    play.setAttribute('aria-label', value ? 'Pause preview' : 'Play preview');
  }

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

  function displayedPreview() {
    return active() && Boolean(currentSrc()) && Boolean(optimized.dataset.id) && optimized.readyState >= 1;
  }

  function prepareReplacement() {
    if (!displayedPreview()) return;
    const src = currentSrc();
    const playing = !optimized.paused && !optimized.ended;
    pending = {
      oldSrc:src,
      playing,
      relative:clamp(Number(optimized.currentTime) || 0, 0, duration()),
      oldOffset:Number.isFinite(sourceOffset()) ? sourceOffset() : 0,
      swapCaptured:false,
      restoring:false
    };

    // startPreview() still contains legacy teardown calls. Suppress exactly the
    // first pause on each displayed decoder so the approved preview keeps
    // playing while the replacement is encoded.
    if (playing) {
      suppressOptimizedPause = true;
      suppressOriginalPause = true;
      setTimeout(() => {
        suppressOptimizedPause = false;
        suppressOriginalPause = false;
        if (pending?.oldSrc === currentSrc() && !optimized.paused) setPlaying(true);
      }, 0);
    }
  }

  function isSettingEvent(event) {
    const target = event.target;
    if (!target?.closest) return false;
    if (event.type === 'click') return Boolean(target.closest('[data-value]'));
    if (event.type === 'change') return Boolean(target.closest('[data-q],[data-e],[data-s]'));
    return false;
  }

  controls.addEventListener('click', event => {
    if (isSettingEvent(event)) prepareReplacement();
  }, true);
  controls.addEventListener('change', event => {
    if (isSettingEvent(event)) prepareReplacement();
  }, true);

  function captureSwap() {
    if (!pending || pending.oldSrc !== currentSrc() || pending.swapCaptured) return;
    pending.swapCaptured = true;
    pending.playing = !optimized.paused && !optimized.ended;
    pending.relative = clamp(Number(optimized.currentTime) || 0, 0, duration());
    const offset = sourceOffset();
    if (Number.isFinite(offset)) pending.oldOffset = offset;
  }

  Object.defineProperty(optimized, 'pause', {
    configurable:true,
    value() {
      if (suppressOptimizedPause && pending?.oldSrc === currentSrc()) {
        suppressOptimizedPause = false;
        return;
      }
      captureSwap();
      return nativeOptimizedPause();
    }
  });

  Object.defineProperty(original, 'pause', {
    configurable:true,
    value() {
      if (suppressOriginalPause && pending?.oldSrc === currentSrc()) {
        suppressOriginalPause = false;
        return;
      }
      return nativeOriginalPause();
    }
  });

  async function seekDisplayed(relative, resume) {
    const point = clamp(Number(relative) || 0, 0, Math.max(0, duration() - .001));
    const offset = Number.isFinite(sourceOffset()) ? sourceOffset() : pending?.oldOffset || 0;
    nativeOptimizedPause();
    nativeOriginalPause();
    try { optimized.currentTime = point; } catch {}
    try { original.currentTime = Math.max(0, offset + point); } catch {}
    await Promise.all([waitForSeek(optimized), waitForSeek(original)]);
    if (resume && active()) {
      await Promise.allSettled([nativeOriginalPlay(), nativeOptimizedPlay()]);
      setPlaying(true);
    } else setPlaying(false);
  }

  // While a replacement encode is pending, the base module's session points at
  // that encode rather than the still-visible preview. Keep transport controls
  // attached to what the user can actually see.
  const basePlay = play.onclick;
  play.onclick = async event => {
    if (!pending || pending.oldSrc !== currentSrc()) return basePlay?.call(play, event);
    if (!optimized.paused && !optimized.ended) {
      pending.playing = false;
      pending.relative = Number(optimized.currentTime) || 0;
      nativeOptimizedPause();
      nativeOriginalPause();
      setPlaying(false);
      return;
    }
    if (optimized.ended || Number(optimized.currentTime) >= duration() - .03) {
      await seekDisplayed(0, true);
    } else {
      await Promise.allSettled([nativeOriginalPlay(), nativeOptimizedPlay()]);
      setPlaying(true);
    }
    pending.playing = true;
  };

  const baseScrub = playhead.oninput;
  playhead.oninput = () => {
    if (!pending || pending.oldSrc !== currentSrc()) return baseScrub?.call(playhead);
    const point = clamp(Number(playhead.value) || 0, 0, duration());
    pending.playing = false;
    pending.relative = point;
    seekDisplayed(point, false).catch(() => {});
  };

  // The old preview must still loop while a replacement takes longer than the
  // six-second sample. The base handler cannot do this because its active
  // session now represents the pending encode.
  optimized.addEventListener('ended', () => {
    if (!pending || pending.oldSrc !== currentSrc() || !pending.playing || !active()) return;
    seekDisplayed(0, true).catch(() => {});
  });

  async function restoreReplacement(token) {
    if (!pending || pending !== token || token.restoring || !active()) return;
    const src = currentSrc();
    if (!src || src === token.oldSrc) return;
    token.restoring = true;
    const serial = ++restoreSerial;

    try {
      // installPreview() starts the new preview at t=0. At this point those
      // seeks are complete, so the decoder offset is the new sampleStart.
      nativeOptimizedPause();
      nativeOriginalPause();
      const newOffset = sourceOffset();
      const point = clamp(token.relative, 0, Math.max(0, duration() - .001));
      try { optimized.currentTime = point; } catch {}
      try { original.currentTime = Math.max(0, (Number.isFinite(newOffset) ? newOffset : 0) + point); } catch {}
      await Promise.all([waitForSeek(optimized), waitForSeek(original)]);
      if (serial !== restoreSerial || pending !== token || !active()) return;

      if (token.playing) {
        await Promise.allSettled([nativeOriginalPlay(), nativeOptimizedPlay()]);
        setPlaying(true);
      } else {
        setPlaying(false);
      }
      if (pending === token) pending = null;
    } finally {
      token.restoring = false;
    }
  }

  optimized.addEventListener('playing', () => {
    const token = pending;
    if (!token || currentSrc() === token.oldSrc || token.restoring) return;
    // Run after installPreview()'s play call has completed so its t=0 setup is
    // finished before we move to the continuously advancing old-preview time.
    setTimeout(() => restoreReplacement(token).catch(() => {}), 0);
  });

  window.addEventListener('mochimono:optimize-close', () => {
    pending = null;
    suppressOptimizedPause = false;
    suppressOriginalPause = false;
    restoreSerial++;
  });
}
