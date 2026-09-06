const viewer = document.querySelector('#viewer');
const media = document.querySelector('#viewer-media');
const openLink = document.querySelector('#viewer-open');
const nameEl = document.querySelector('#viewer-name');
const actions = viewer?.querySelector('.viewer-actions');
const CLIENT = document.documentElement.classList.contains('client-library');

const EXTS = new Set(['mp4','m4v','mov','mkv','webm','avi','mpg','mpeg','m2v','mts','m2ts','3gp']);
const ext = name => String(name || '').toLowerCase().match(/\.([^.]+)$/)?.[1] || '';
const hash = () => openLink?.getAttribute('href')?.match(/\/api\/objects\/([a-f0-9]{64})/)?.[1] || '';
const source = () => media?.querySelector(':scope > video') || null;
const isVideo = () => CLIENT && Boolean(source()) && EXTS.has(ext(nameEl?.textContent));

const style = document.createElement('style');
style.textContent = `
.video-optimize-trigger[hidden]{display:none!important}
.viewer.video-optimize-active .viewer-optimize-trigger{display:none!important}
.video-optimize-layer[hidden]{display:none!important}
.video-optimize-layer{position:absolute;z-index:120;inset:0;overflow:hidden;background:#050505;color:#eee}
.viewer.video-optimize-active .viewer-nav{display:none!important}
.video-optimize-compare{--split:50%;position:absolute;inset:0;background:#050505;touch-action:none;overflow:hidden}
.video-optimize-canvas{position:absolute;inset:0;width:100%;height:100%;background:#050505;pointer-events:none}
.video-optimize-decode{position:absolute;left:0;top:0;width:100%;height:100%;opacity:0;pointer-events:none}
.video-optimize-label{position:absolute;z-index:4;top:18px;font-size:11px;font-weight:750;text-shadow:0 1px 5px #000;pointer-events:none}
.video-optimize-label.original{left:16px;color:#ff74b7}.video-optimize-label.optimized{right:16px;color:#72b6ff}
.video-optimize-divider{position:absolute;z-index:5;left:var(--split);top:0;bottom:0;width:48px;transform:translateX(-50%);cursor:e-resize;touch-action:none}
.video-optimize-divider:before{content:'';position:absolute;left:50%;top:0;bottom:0;width:3px;transform:translateX(-50%);background:rgba(8,8,10,.82);box-shadow:-1px 0 0 rgba(255,79,163,.34),1px 0 0 rgba(78,161,255,.34)}
.video-optimize-divider-handle{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:flex;align-items:center;justify-content:center;gap:4px;width:50px;height:36px;border-radius:18px;background:rgba(8,8,10,.78);border:1px solid rgba(255,255,255,.18);box-shadow:0 4px 18px rgba(0,0,0,.4);backdrop-filter:blur(8px)}
.video-optimize-divider:hover .video-optimize-divider-handle{background:rgba(8,8,10,.9);border-color:rgba(255,255,255,.3)}
.video-optimize-divider-left,.video-optimize-divider-right{width:0;height:0;border-top:8px solid transparent;border-bottom:8px solid transparent;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))}
.video-optimize-divider-left{border-right:12px solid #ff4fa3}.video-optimize-divider-right{border-left:12px solid #4ea1ff}
.video-optimize-card{position:absolute;z-index:8;bottom:max(14px,env(safe-area-inset-bottom));width:min(350px,calc(50% - 24px));padding:14px;border:1px solid rgba(255,255,255,.08);border-radius:14px;background:rgba(20,19,20,.92);box-shadow:0 16px 48px rgba(0,0,0,.46);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px)}
.video-optimize-card-left{left:max(14px,env(safe-area-inset-left))}
.video-optimize-card-right{right:max(14px,env(safe-area-inset-right));max-height:calc(100dvh - 28px);overflow:auto}
.video-optimize-close{position:absolute;z-index:2;top:8px;right:8px;width:28px;height:28px;padding:0;border:0;border-radius:50%;display:flex;align-items:center;justify-content:center;background:transparent;color:#8f8885;font:400 22px/1 Arial,sans-serif;cursor:pointer}
.video-optimize-close:hover{background:rgba(255,255,255,.08);color:#fff}
.video-optimize-result{padding-right:30px}.video-optimize-line{display:flex;align-items:baseline;gap:8px}
.video-optimize-saving{font-size:36px;line-height:.9;letter-spacing:-.045em;font-weight:790;white-space:nowrap}
.video-optimize-card-left .video-optimize-saving{color:#ff74b7}.video-optimize-card-right .video-optimize-saving{color:#6fb1ff}
.video-optimize-size{color:#ddd6d2;font-size:17px;font-weight:700;white-space:nowrap;font-variant-numeric:tabular-nums}
.video-optimize-status{margin-top:6px;color:#968e8a;font-size:11px;line-height:1.35}
.video-optimize-progress{height:3px;margin-top:8px;overflow:hidden;border-radius:99px;background:#ffffff14}.video-optimize-progress[hidden]{display:none!important}.video-optimize-progress i{display:block;height:100%;width:0;background:#72b6ff}
.video-optimize-play{display:grid;grid-template-columns:34px 1fr auto;align-items:center;gap:8px;margin-top:12px}
.video-optimize-play button{width:34px;height:30px;padding:0;border:0;border-radius:8px;background:#2a2829;color:#eee;display:flex;align-items:center;justify-content:center;line-height:1}
.video-optimize-play button:hover{background:#343132;color:#fff}.video-optimize-play-icon{display:block;line-height:1;transform:translateY(-.5px)}.video-optimize-play button[data-playing="0"] .video-optimize-play-icon{transform:translate(1px,-.5px)}
.video-optimize-play input,.video-optimize-section input[type=range]{width:100%;margin:0;accent-color:#eee9e5}.video-optimize-time{min-width:66px;text-align:right;color:#aaa29e;font-size:10px}
.video-optimize-section{display:grid;gap:7px;margin-top:10px;padding:10px;border-radius:10px;background:rgba(255,255,255,.035)}
.video-optimize-head{display:flex;justify-content:space-between;color:#d6cfcb;font-size:11px;font-weight:700}.video-optimize-head output{color:#aaa29e}
.video-optimize-choices{display:grid;grid-template-columns:repeat(3,1fr);gap:5px}.video-optimize-choices.five{grid-template-columns:repeat(5,1fr)}
.video-optimize-choice{min-height:32px;padding:0 5px;border:0;border-radius:8px;background:#2a2829;color:#bfb8b4;font-size:10.5px;font-weight:700}.video-optimize-choice:hover{background:#343132;color:#fff}.video-optimize-choice.active{background:#eee9e5;color:#171416}.video-optimize-choice:disabled{opacity:.3}
.video-optimize-note{color:#77706d;font-size:9.5px;line-height:1.35}
.video-optimize-actions{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:10px}.video-optimize-actions button{min-height:38px;border:0;border-radius:9px;font-size:12px;font-weight:750}.video-optimize-keep{background:#2a2829;color:#d2cbc7}.video-optimize-replace{background:#eee9e5;color:#171416}.video-optimize-actions button:disabled{opacity:.35}
@media(max-width:760px){.video-optimize-card{width:calc(50% - 12px);padding:10px}.video-optimize-card-left{left:max(8px,env(safe-area-inset-left))}.video-optimize-card-right{right:max(8px,env(safe-area-inset-right));max-height:calc(100dvh - 16px)}.video-optimize-saving{font-size:32px}.video-optimize-choices.five{grid-template-columns:repeat(3,1fr)}.video-optimize-divider-handle{width:44px;height:32px}.video-optimize-divider-left,.video-optimize-divider-right{border-top-width:7px;border-bottom-width:7px}.video-optimize-divider-left{border-right-width:10px}.video-optimize-divider-right{border-left-width:10px}}
`;
document.head.append(style);

const trigger = document.createElement('button');
trigger.type = 'button';
trigger.className = 'viewer-optimize-trigger viewer-action video-optimize-trigger';
trigger.textContent = 'Compress';
trigger.hidden = true;
if (actions) {
  const imageButton = actions.querySelector('.viewer-optimize-trigger');
  if (imageButton) imageButton.after(trigger);
  else if (openLink?.parentElement === actions) openLink.before(trigger);
  else actions.prepend(trigger);
}

const layer = document.createElement('div');
layer.className = 'video-optimize-layer';
layer.hidden = true;
layer.innerHTML = `
  <div class="video-optimize-compare" data-c>
    <canvas class="video-optimize-canvas" data-canvas></canvas>
    <video class="video-optimize-decode" data-o playsinline preload="auto" muted></video>
    <video class="video-optimize-decode" data-a playsinline preload="auto"></video>
    <span class="video-optimize-label original">Original</span>
    <span class="video-optimize-label optimized" data-l>AV1</span>
    <i class="video-optimize-divider" data-d><span class="video-optimize-divider-handle" aria-hidden="true"><span class="video-optimize-divider-left"></span><span class="video-optimize-divider-right"></span></span></i>
  </div>
  <div class="video-optimize-card video-optimize-card-left">
    <button class="video-optimize-close" data-close-left aria-label="Close compression">×</button>
    <div class="video-optimize-result">
      <div class="video-optimize-line"><strong class="video-optimize-saving">0%</strong><span class="video-optimize-size" data-source-size>Original</span></div>
      <div class="video-optimize-status" data-source-status>Uncompressed source</div>
    </div>
  </div>
  <div class="video-optimize-card video-optimize-card-right" data-controls>
    <button class="video-optimize-close" data-close-right aria-label="Close compression">×</button>
    <div class="video-optimize-result">
      <div class="video-optimize-line"><strong class="video-optimize-saving" data-save>—</strong><span class="video-optimize-size" data-size>Preparing…</span></div>
      <div class="video-optimize-status" data-status>Starting AV1 preview…</div>
      <div class="video-optimize-progress" data-progress hidden><i></i></div>
    </div>
    <div class="video-optimize-play"><button data-play data-playing="0" aria-label="Play preview"><span class="video-optimize-play-icon" data-play-icon>▶</span></button><input data-playhead type="range" min="0" max="6" step="0.001" value="0"><span class="video-optimize-time" data-time>0:00 / 0:06</span></div>
    <div class="video-optimize-section"><div class="video-optimize-head"><span>Encoder</span><output data-enc-label>Auto</output></div><div class="video-optimize-choices" data-enc><button class="video-optimize-choice active" data-value="auto">Auto</button><button class="video-optimize-choice" data-value="gpu">GPU</button><button class="video-optimize-choice" data-value="cpu">CPU</button></div><div class="video-optimize-note" data-cap>Checking AV1 encoders…</div></div>
    <div class="video-optimize-section"><div class="video-optimize-head"><span>Resolution</span><output data-res-label>Original</output></div><div class="video-optimize-choices five" data-res><button class="video-optimize-choice active" data-value="0">Original</button><button class="video-optimize-choice" data-value="3840">4K</button><button class="video-optimize-choice" data-value="2560">1440p</button><button class="video-optimize-choice" data-value="1920">1080p</button><button class="video-optimize-choice" data-value="1280">720p</button></div></div>
    <div class="video-optimize-section"><div class="video-optimize-head"><span>Frame rate</span><output data-fps-label>Original</output></div><div class="video-optimize-choices" data-fps><button class="video-optimize-choice active" data-value="0">Original</button><button class="video-optimize-choice" data-value="60">60 fps</button><button class="video-optimize-choice" data-value="30">30 fps</button></div></div>
    <div class="video-optimize-section"><div class="video-optimize-head"><span>Quality</span><output data-q-label>72</output></div><input data-q type="range" min="1" max="100" value="72"></div>
    <div class="video-optimize-section"><div class="video-optimize-head"><span>Effort</span><output data-e-label>7 / 9</output></div><input data-e type="range" min="0" max="9" value="7"></div>
    <div class="video-optimize-section"><div class="video-optimize-head"><span>Sample</span><output data-s-label>0:00</output></div><input data-s type="range" min="0" max="1" step="0.5" value="0"><div class="video-optimize-note">Encodes about 6 seconds around this point. Preview playback loops automatically.</div></div>
    <div class="video-optimize-actions"><button class="video-optimize-keep" data-keep disabled>Keep copy</button><button class="video-optimize-replace" data-replace disabled>Replace original</button></div>
  </div>`;
viewer?.append(layer);

const $ = selector => layer.querySelector(selector);
const compare = $('[data-c]');
const canvas = $('[data-canvas]');
const ctx = canvas.getContext('2d', { alpha:false });
const original = $('[data-o]');
const after = $('[data-a]');
const rightLabel = $('[data-l]');
const controls = $('[data-controls]');
const save = $('[data-save]');
const size = $('[data-size]');
const status = $('[data-status]');
const sourceSize = $('[data-source-size]');
const sourceStatus = $('[data-source-status]');
const progress = $('[data-progress]');
const bar = progress.querySelector('i');
const play = $('[data-play]');
const playIcon = $('[data-play-icon]');
const playhead = $('[data-playhead]');
const time = $('[data-time]');
const enc = $('[data-enc]');
const encLabel = $('[data-enc-label]');
const cap = $('[data-cap]');
const res = $('[data-res]');
const resLabel = $('[data-res-label]');
const fps = $('[data-fps]');
const fpsLabel = $('[data-fps-label]');
const q = $('[data-q]');
const qLabel = $('[data-q-label]');
const eff = $('[data-e]');
const effLabel = $('[data-e-label]');
const sample = $('[data-s]');
const sampleLabel = $('[data-s-label]');
const keep = $('[data-keep]');
const replace = $('[data-replace]');

let session = null;
let serial = 0;
let timer = 0;
let activeHash = '';
let committing = false;
let splitPointer = null;
let sourceState = null;
let split = 50;
let frameGeneration = 0;
let hardSyncing = false;
let previewLoadSerial = 0;
let opt = { encoder:'auto', quality:72, effort:7, maxEdge:0, fps:0 };

const active = () => viewer?.classList.contains('video-optimize-active');
const bytes = value => {
  const units = ['B','KB','MB','GB','TB'];
  let amount = Math.abs(Number(value) || 0);
  let index = 0;
  while (amount >= 1000 && index < units.length - 1) { amount /= 1000; index++; }
  return `${amount < 10 && index ? amount.toFixed(1) : Math.round(amount)} ${units[index]}`;
};
const clock = value => {
  const seconds = Math.max(0, Number(value) || 0);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor(seconds % 3600 / 60);
  const s = Math.floor(seconds % 60);
  return h ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${m}:${String(s).padStart(2,'0')}`;
};

async function api(path, init = {}) {
  const response = await fetch(path, { headers:{ 'content-type':'application/json', ...(init.headers || {}) }, ...init });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(data.error || response.statusText);
  return data;
}

function choose(group, value) {
  for (const button of group.querySelectorAll('[data-value]')) button.classList.toggle('active', String(button.dataset.value) === String(value));
}

function syncControls() {
  choose(enc, opt.encoder);
  choose(res, opt.maxEdge);
  choose(fps, opt.fps);
  encLabel.textContent = opt.encoder === 'gpu' ? 'GPU' : opt.encoder === 'cpu' ? 'CPU' : 'Auto';
  resLabel.textContent = ({ 0:'Original', 3840:'4K', 2560:'1440p', 1920:'1080p', 1280:'720p' })[opt.maxEdge] || 'Original';
  fpsLabel.textContent = opt.fps ? `${opt.fps} fps` : 'Original';
  q.value = opt.quality;
  qLabel.textContent = opt.quality;
  eff.value = opt.effort;
  effLabel.textContent = `${opt.effort} / 9`;
}

async function capabilities() {
  try {
    const data = await api('/api/video-optimize/capabilities');
    enc.querySelector('[data-value="gpu"]').disabled = !data.hardware;
    enc.querySelector('[data-value="cpu"]').disabled = !data.software;
    cap.textContent = data.hardware
      ? `${data.gpu || 'Hardware AV1'} available${data.software ? ` · ${data.cpu || 'CPU AV1'} fallback` : ''}`
      : data.software
        ? `${data.cpu || 'CPU AV1'} available · no AV1 GPU encoder detected`
        : 'No AV1 encoder detected';
  } catch (error) {
    cap.textContent = error.message;
  }
}

function containedRect(video) {
  const width = compare.clientWidth || 1;
  const height = compare.clientHeight || 1;
  const ratio = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : width / height;
  let drawWidth = width;
  let drawHeight = drawWidth / ratio;
  if (drawHeight > height) {
    drawHeight = height;
    drawWidth = drawHeight * ratio;
  }
  return { x:(width - drawWidth) / 2, y:(height - drawHeight) / 2, width:drawWidth, height:drawHeight };
}

function resizeCanvas() {
  const dpr = Math.max(1, Math.min(2, devicePixelRatio || 1));
  const width = Math.max(1, Math.round(compare.clientWidth * dpr));
  const height = Math.max(1, Math.round(compare.clientHeight * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawComposite() {
  if (!session?.preview || !original.videoWidth || !after.videoWidth) return;
  resizeCanvas();
  const width = compare.clientWidth || 1;
  const height = compare.clientHeight || 1;
  const rect = containedRect(after);
  ctx.fillStyle = '#050505';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(original, rect.x, rect.y, rect.width, rect.height);
  ctx.save();
  ctx.beginPath();
  ctx.rect(width * split / 100, 0, width * (1 - split / 100), height);
  ctx.clip();
  ctx.drawImage(after, rect.x, rect.y, rect.width, rect.height);
  ctx.restore();
}

function updateTimeline(value = Number(after.currentTime) || 0) {
  const duration = Math.max(.01, Number(session?.sampleDuration) || 6);
  const current = Math.max(0, Math.min(duration, value));
  playhead.max = duration;
  if (document.activeElement !== playhead) playhead.value = current;
  time.textContent = `${clock(current)} / ${clock(duration)}`;
}

function setPlaying(value) {
  play.dataset.playing = value ? '1' : '0';
  playIcon.textContent = value ? '❚❚' : '▶';
  play.setAttribute('aria-label', value ? 'Pause preview' : 'Play preview');
}

function syncOriginalTo(masterTime, force = false) {
  if (!session?.preview || hardSyncing || !Number.isFinite(masterTime)) return;
  const expected = session.sampleStart + masterTime;
  const drift = Number(original.currentTime) - expected;
  const rate = Math.max(24, Number(session.targetFps || session.fps || 30) || 30);
  const hardThreshold = Math.max(.06, 2.25 / rate);

  if (force || Math.abs(drift) > hardThreshold) {
    hardSyncing = true;
    original.playbackRate = 1;
    try { original.currentTime = Math.max(0, expected); } catch {}
    const clear = () => {
      hardSyncing = false;
      original.removeEventListener('seeked', clear);
    };
    original.addEventListener('seeked', clear, { once:true });
    setTimeout(clear, 160);
    return;
  }

  if (!original.paused && !after.paused) {
    original.playbackRate = Math.max(.97, Math.min(1.03, 1 - drift * .45));
  }
}

function startFrameLoop() {
  const generation = ++frameGeneration;
  const frame = (_, metadata) => {
    if (generation !== frameGeneration || !active()) return;
    const masterTime = Number(metadata?.mediaTime ?? after.currentTime) || 0;
    syncOriginalTo(masterTime);
    drawComposite();
    updateTimeline(masterTime);
    after.requestVideoFrameCallback?.(frame);
  };
  if (after.requestVideoFrameCallback) after.requestVideoFrameCallback(frame);
  else {
    const fallback = () => {
      if (generation !== frameGeneration || !active()) return;
      syncOriginalTo(Number(after.currentTime) || 0);
      drawComposite();
      updateTimeline();
      requestAnimationFrame(fallback);
    };
    requestAnimationFrame(fallback);
  }
}

function waitFor(video, event) {
  return new Promise(resolve => {
    if (event === 'loadedmetadata' && video.readyState >= 1) return resolve();
    const done = () => resolve();
    video.addEventListener(event, done, { once:true });
    setTimeout(done, 1800);
  });
}

async function seekPair(relative, resume = false) {
  if (!session?.preview) return;
  const duration = Math.max(.01, Number(session.sampleDuration) || 6);
  const point = Math.max(0, Math.min(duration, Number(relative) || 0));
  after.pause();
  original.pause();
  original.playbackRate = 1;
  try { after.currentTime = point; } catch {}
  try { original.currentTime = session.sampleStart + point; } catch {}
  await Promise.all([waitFor(after, 'seeked'), waitFor(original, 'seeked')]);
  drawComposite();
  updateTimeline(point);
  if (resume && active()) {
    await Promise.allSettled([original.play(), after.play()]);
    setPlaying(true);
  } else setPlaying(false);
}

async function installPreview(data) {
  const loadSerial = ++previewLoadSerial;
  after.pause();
  original.pause();
  frameGeneration++;
  after.dataset.id = data.id;
  after.src = `${data.preview.url}&v=${Date.now()}`;
  original.src = `/api/objects/${data.hash}`;
  original.muted = true;
  after.muted = false;
  after.load();
  original.load();
  await Promise.all([waitFor(after, 'loadedmetadata'), waitFor(original, 'loadedmetadata')]);
  if (!active() || loadSerial !== previewLoadSerial || session?.id !== data.id) return;
  startFrameLoop();
  await seekPair(0, true);
}

function fail(message) {
  progress.hidden = true;
  save.textContent = '—';
  size.textContent = 'Error';
  status.textContent = message || 'Video compression failed';
  keep.disabled = true;
  replace.disabled = true;
  setPlaying(false);
}

function consume(data, requestSerial) {
  if (!active() || requestSerial !== serial) return;
  session = data;
  const percent = Number(data.progress?.percent) || 0;
  const busy = ['encoding','queued','starting','committing'].includes(data.status);
  progress.hidden = !busy;
  bar.style.width = `${Math.max(2, Math.min(100, percent))}%`;
  if (busy) status.textContent = data.status === 'queued' ? 'Waiting for encoder…' : `${data.progress?.label || 'Encoding…'}${percent ? ` · ${Math.round(percent)}%` : ''}`;

  if (data.duration) {
    sample.max = data.duration;
    if (document.activeElement !== sample) sample.value = Math.min(data.duration, Math.max(0, Number(sample.value) || data.sampleStart + data.sampleDuration / 2));
    sampleLabel.textContent = clock(sample.value);
  }

  if (data.width && data.height) {
    sourceSize.textContent = bytes(data.sourceSize);
    sourceStatus.textContent = ['Uncompressed source', `${Number(data.width).toLocaleString()}×${Number(data.height).toLocaleString()}`, data.fps ? `${Number(data.fps).toFixed(data.fps % 1 ? 1 : 0)} fps` : '', data.duration ? clock(data.duration) : ''].filter(Boolean).join(' · ');
  }

  if (data.preview && data.status !== 'committing') {
    const savingPercent = Number(data.estimatedPercent) || 0;
    save.textContent = savingPercent >= 0 ? `${Math.round(savingPercent)}%` : `+${Math.round(Math.abs(savingPercent))}%`;
    size.textContent = `~${bytes(data.estimatedSize)}`;
    rightLabel.textContent = data.encoder?.hardware ? 'AV1 · GPU' : 'AV1';
    const tuning = Array.isArray(data.encoder?.tuning) && data.encoder.tuning.length ? data.encoder.tuning.join(' · ') : '';
    status.textContent = [
      data.encoder?.label || 'AV1',
      tuning,
      data.targetWidth && data.targetHeight ? `${Number(data.targetWidth).toLocaleString()}×${Number(data.targetHeight).toLocaleString()}` : '',
      data.targetFps ? `${Number(data.targetFps).toFixed(data.targetFps % 1 ? 1 : 0)} fps` : '',
      data.rate?.targetVideoKbps ? `~${Number(data.rate.targetVideoKbps).toLocaleString()} kbps video` : '',
      data.hasAudio && data.rate?.audioKbps ? `Opus ${data.rate.audioKbps} kbps` : ''
    ].filter(Boolean).join(' · ');
    if (after.dataset.id !== data.id) installPreview(data).catch(error => fail(error.message));
    keep.disabled = replace.disabled = committing;
  }

  if (data.status === 'error') return fail(data.error);
  if (data.status === 'committed') {
    const saved = Number(data.result?.saved) || 0;
    save.textContent = saved ? `${Math.round(saved / Math.max(1, data.sourceSize) * 100)}%` : 'Saved';
    size.textContent = bytes(data.result?.size || 0);
    status.textContent = `${data.result?.filename || 'Saved'}${saved ? ` · saved ${bytes(saved)}` : ''}`;
    committing = false;
    keep.disabled = replace.disabled = true;
    setTimeout(() => {
      closeOptimizer();
      if (data.result?.mode === 'replace') document.querySelector('#viewer-close')?.click();
      setTimeout(() => {
        window.mochimonoLibrary?.refresh?.();
        window.mochimonoLocations?.refresh?.();
        window.dispatchEvent(new CustomEvent('mochimono:catalog-updated'));
      }, 500);
      setTimeout(() => window.mochimonoLibrary?.refresh?.(), 1700);
    }, 700);
    return;
  }

  keep.disabled = replace.disabled = busy || committing || data.status !== 'ready';
  if (data.status !== 'ready') poll(data.id, requestSerial);
}

function poll(id, requestSerial) {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    if (!active() || requestSerial !== serial || id !== session?.id) return;
    try { consume(await api(`/api/video-optimize/status?id=${encodeURIComponent(id)}`), requestSerial); }
    catch (error) { if (requestSerial === serial) fail(error.message); }
  }, 260);
}

async function startPreview(at = Number(sample.value) || sourceState?.time || 0) {
  if (!active() || committing || !activeHash) return;
  const requestSerial = ++serial;
  clearTimeout(timer);
  session = null;
  frameGeneration++;
  after.pause();
  original.pause();
  setPlaying(false);
  keep.disabled = replace.disabled = true;
  progress.hidden = false;
  bar.style.width = '4%';
  save.textContent = '—';
  size.textContent = 'Preparing…';
  status.textContent = 'Starting AV1 preview…';
  try {
    const data = await api('/api/video-optimize/start', {
      method:'POST',
      body:JSON.stringify({ hash:activeHash, at, options:opt })
    });
    if (active() && requestSerial === serial) consume(data, requestSerial);
  } catch (error) {
    if (requestSerial === serial) fail(error.message);
  }
}

async function commit(mode) {
  if (committing || session?.status !== 'ready') return;
  if (mode === 'replace' && !confirm(`Replace ${session.filename} with the approved AV1 WebM?\n\nMochimono will encode the full video with these exact settings, verify it, then replace the original.`)) return;
  committing = true;
  keep.disabled = replace.disabled = true;
  progress.hidden = false;
  bar.style.width = '2%';
  status.textContent = 'Starting full AV1 encode…';
  try {
    consume(await api('/api/video-optimize/commit', {
      method:'POST',
      body:JSON.stringify({ id:session.id, mode })
    }), serial);
  } catch (error) {
    committing = false;
    fail(error.message);
  }
}

function reset() {
  serial++;
  previewLoadSerial++;
  frameGeneration++;
  clearTimeout(timer);
  session = null;
  activeHash = '';
  committing = false;
  splitPointer = null;
  hardSyncing = false;
  after.pause();
  original.pause();
  after.removeAttribute('src');
  original.removeAttribute('src');
  after.load();
  original.load();
  after.dataset.id = '';
  progress.hidden = true;
  setPlaying(false);
}

function closeOptimizer() {
  if (!active()) return;
  const video = source();
  viewer.classList.remove('video-optimize-active');
  layer.hidden = true;
  window.dispatchEvent(new CustomEvent('mochimono:optimize-close'));
  if (video && sourceState) {
    try { video.currentTime = sourceState.time; } catch {}
    video.volume = sourceState.volume;
    video.muted = sourceState.muted;
    if (!sourceState.paused) video.play().catch(() => {});
  }
  reset();
  sourceState = null;
  syncTrigger();
}

function openOptimizer() {
  if (!isVideo() || !hash()) return;
  const video = source();
  sourceState = { time:Number(video.currentTime) || 0, paused:video.paused, volume:video.volume, muted:video.muted };
  video.pause();
  activeHash = hash();
  opt = { encoder:'auto', quality:72, effort:7, maxEdge:0, fps:0 };
  sample.min = 0;
  sample.max = Math.max(1, Number(video.duration) || 1);
  sample.value = sourceState.time;
  sampleLabel.textContent = clock(sample.value);
  sourceSize.textContent = 'Original';
  sourceStatus.textContent = 'Uncompressed source';
  save.textContent = '—';
  size.textContent = 'Preparing…';
  status.textContent = 'Starting AV1 preview…';
  rightLabel.textContent = 'AV1';
  setSplit(50);
  syncControls();
  viewer.classList.add('video-optimize-active');
  layer.hidden = false;
  syncTrigger();
  window.dispatchEvent(new CustomEvent('mochimono:optimize-open'));
  capabilities();
  startPreview(sourceState.time);
}

function syncTrigger() {
  trigger.hidden = active() || !isVideo() || !hash();
}

function setChoice(group, key, number = false) {
  group.onclick = event => {
    const button = event.target.closest('[data-value]');
    if (!button || button.disabled) return;
    const value = number ? (Number(button.dataset.value) || 0) : button.dataset.value;
    if (opt[key] === value) return;
    opt[key] = value;
    syncControls();
    startPreview();
  };
}

setChoice(enc, 'encoder');
setChoice(res, 'maxEdge', true);
setChoice(fps, 'fps', true);
q.oninput = () => { opt.quality = Number(q.value); qLabel.textContent = q.value; };
q.onchange = () => startPreview();
eff.oninput = () => { opt.effort = Number(eff.value); effLabel.textContent = `${opt.effort} / 9`; };
eff.onchange = () => startPreview();
sample.oninput = () => { sampleLabel.textContent = clock(sample.value); };
sample.onchange = () => startPreview(Number(sample.value) || 0);
keep.onclick = () => commit('keep');
replace.onclick = () => commit('replace');
$('[data-close-left]').onclick = closeOptimizer;
$('[data-close-right]').onclick = closeOptimizer;
trigger.onclick = openOptimizer;
controls.onpointerdown = event => event.stopPropagation();

play.onclick = async () => {
  if (!session?.preview) return;
  if (!after.paused) {
    after.pause();
    original.pause();
    original.playbackRate = 1;
    setPlaying(false);
    return;
  }
  const duration = Math.max(.01, Number(session.sampleDuration) || 6);
  const point = Number(after.currentTime) >= duration - .03 ? 0 : Number(after.currentTime) || 0;
  await seekPair(point, true);
};

after.addEventListener('playing', () => {
  if (original.paused) original.play().catch(() => {});
  setPlaying(true);
});
after.addEventListener('waiting', () => {
  if (!original.paused) original.pause();
});
after.addEventListener('pause', () => {
  if (!original.paused) original.pause();
  original.playbackRate = 1;
  if (!after.ended) setPlaying(false);
});
after.addEventListener('ended', () => {
  original.pause();
  original.playbackRate = 1;
  if (active() && session?.preview) seekPair(0, true);
});
playhead.oninput = () => seekPair(Number(playhead.value) || 0, false);

function setSplit(value) {
  split = Math.max(0, Math.min(100, Number(value) || 0));
  compare.style.setProperty('--split', `${split}%`);
  drawComposite();
}

compare.addEventListener('pointerdown', event => {
  const rect = compare.getBoundingClientRect();
  const dividerX = rect.left + rect.width * split / 100;
  if (!active() || Math.abs(event.clientX - dividerX) > (event.pointerType === 'touch' ? 50 : 32)) return;
  splitPointer = event.pointerId;
  try { compare.setPointerCapture(event.pointerId); } catch {}
  setSplit((event.clientX - rect.left) / rect.width * 100);
  event.preventDefault();
}, true);
compare.addEventListener('pointermove', event => {
  if (event.pointerId !== splitPointer) return;
  const rect = compare.getBoundingClientRect();
  setSplit((event.clientX - rect.left) / rect.width * 100);
  event.preventDefault();
}, true);
for (const type of ['pointerup','pointercancel']) compare.addEventListener(type, event => {
  if (event.pointerId === splitPointer) splitPointer = null;
}, true);

if (typeof ResizeObserver === 'function') new ResizeObserver(drawComposite).observe(compare);
else window.addEventListener('resize', drawComposite, { passive:true });

document.addEventListener('keydown', event => {
  if (!active()) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopImmediatePropagation();
    closeOptimizer();
  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    event.stopImmediatePropagation();
  } else if (event.key === ' ') {
    event.preventDefault();
    event.stopImmediatePropagation();
    play.click();
  }
}, true);

if (media) new MutationObserver(() => {
  if (active() && hash() !== activeHash) closeOptimizer();
  syncTrigger();
}).observe(media, { childList:true, subtree:true });
if (nameEl) new MutationObserver(syncTrigger).observe(nameEl, { childList:true, characterData:true, subtree:true });
if (viewer) new MutationObserver(() => {
  if (viewer.hidden && active()) closeOptimizer();
  syncTrigger();
}).observe(viewer, { attributes:true, attributeFilter:['hidden'] });

syncTrigger();
window.mochimonoVideoOptimize = { open:openOptimizer, close:closeOptimizer };
