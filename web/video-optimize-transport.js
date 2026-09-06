const viewer = document.querySelector('#viewer');
const compare = document.querySelector('.video-optimize-compare');
const optimized = compare?.querySelector('[data-a]');
const playhead = document.querySelector('[data-playhead]');
const time = document.querySelector('[data-time]');

if (viewer && optimized && playhead && time) {
  let frame = 0;
  let scrubbing = false;

  const active = () => viewer.classList.contains('video-optimize-active');
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const clock = value => {
    const seconds = Math.max(0, Number(value) || 0);
    const h = Math.floor(seconds / 3600);
    const m = Math.floor(seconds % 3600 / 60);
    const s = Math.floor(seconds % 60);
    return h ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${m}:${String(s).padStart(2,'0')}`;
  };

  function update() {
    if (!active()) return;
    const duration = Number.isFinite(optimized.duration) && optimized.duration > 0
      ? optimized.duration
      : Math.max(.01, Number(playhead.max) || 6);
    const current = clamp(Number(optimized.currentTime) || 0, 0, duration);
    playhead.max = String(duration);
    if (!scrubbing) playhead.value = String(current);
    time.textContent = `${clock(scrubbing ? Number(playhead.value) || current : current)} / ${clock(duration)}`;
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

  playhead.addEventListener('pointerdown', () => { scrubbing = true; });
  playhead.addEventListener('input', () => {
    scrubbing = true;
    const duration = Number.isFinite(optimized.duration) && optimized.duration > 0 ? optimized.duration : Math.max(.01, Number(playhead.max) || 6);
    time.textContent = `${clock(clamp(Number(playhead.value) || 0, 0, duration))} / ${clock(duration)}`;
  });
  const finishScrub = () => {
    scrubbing = false;
    requestAnimationFrame(update);
  };
  playhead.addEventListener('pointerup', finishScrub);
  playhead.addEventListener('pointercancel', finishScrub);
  playhead.addEventListener('change', finishScrub);
  playhead.addEventListener('blur', finishScrub);

  optimized.addEventListener('loadedmetadata', update);
  optimized.addEventListener('durationchange', update);
  optimized.addEventListener('seeked', update);
  optimized.addEventListener('playing', start);
  optimized.addEventListener('pause', update);

  window.addEventListener('mochimono:optimize-open', () => {
    scrubbing = false;
    update();
    start();
  });
  window.addEventListener('mochimono:optimize-close', () => {
    scrubbing = false;
    stop();
  });
}
