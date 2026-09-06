import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import ffmpegStatic from 'ffmpeg-static';
import sharp from 'sharp';
import { CONFIG_DIR, json, now, readJson } from './agent-context.js';
import { invalidateClientProviders } from './client-providers.js';
import { localCandidate } from './local-locations.js';

const DB_PATH = join(CONFIG_DIR, 'work.sqlite');
const RENDITION_DIR = join(CONFIG_DIR, 'renditions');
const IMAGE_WORKER = fileURLToPath(new URL('./image-optimize-worker.js', import.meta.url));
const IMAGE_EXT = new Set(['.jpg','.jpeg','.png','.webp','.avif','.bmp','.gif','.tif','.tiff']);
const VIDEO_EXT = new Set(['.mp4','.m4v','.mov','.mkv','.webm','.avi','.mpg','.mpeg','.m2v','.mts','.m2ts','.3gp']);
const LOSSLESS_FRIENDLY = new Set(['.png','.bmp','.tif','.tiff','.gif']);
const PHOTO_FORMATS = new Set(['jpeg','webp','avif','tiff']);
const AUTO_AVIF_OFFSET = 21;
const db = new DatabaseSync(DB_PATH, { timeout:5000 });
let activeJob = null;
let ffmpegCaps = null;

await mkdir(RENDITION_DIR, { recursive:true });
db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA synchronous=NORMAL;
  PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS compression_presets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    media_type TEXT NOT NULL CHECK(media_type IN ('image','video')),
    options_json TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(media_type, name)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS work_items (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT 'compress',
    original_hash TEXT NOT NULL,
    filename TEXT NOT NULL DEFAULT '',
    media_type TEXT NOT NULL CHECK(media_type IN ('image','video')),
    preset_id TEXT,
    preset_name TEXT NOT NULL DEFAULT '',
    options_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('queued','running','done','error','canceled')),
    progress REAL NOT NULL DEFAULT 0,
    message TEXT NOT NULL DEFAULT '',
    result_json TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  ) STRICT;
  CREATE INDEX IF NOT EXISTS work_status_created ON work_items(status, created_at);
  CREATE INDEX IF NOT EXISTS work_original ON work_items(original_hash, created_at);
  CREATE TABLE IF NOT EXISTS renditions (
    original_hash TEXT PRIMARY KEY,
    rendition_hash TEXT NOT NULL,
    media_type TEXT NOT NULL CHECK(media_type IN ('image','video')),
    preset_id TEXT,
    preset_name TEXT NOT NULL DEFAULT '',
    options_json TEXT NOT NULL,
    path TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    source_size INTEGER NOT NULL,
    width INTEGER NOT NULL DEFAULT 0,
    height INTEGER NOT NULL DEFAULT 0,
    duration REAL,
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS representation_policies (
    location_id TEXT NOT NULL,
    media_type TEXT NOT NULL CHECK(media_type IN ('image','video')),
    representation TEXT NOT NULL CHECK(representation IN ('original','compact')),
    updated_at TEXT NOT NULL,
    PRIMARY KEY(location_id, media_type)
  ) STRICT;
  UPDATE work_items SET status='queued', started_at=NULL, progress=0, message='Resuming after Agent restart'
  WHERE status='running';
`);

const imageDefault = { format:'auto', quality:90, content:'auto', effort:4, lossless:false, resizeMax:2560, resizePercent:0 };
const videoDefault = { encoder:'auto', quality:72, effort:7, maxEdge:0, fps:0, audio:'normal', videoBitrateKbps:0 };
seedDefault('image', 'Default Image', imageDefault);
seedDefault('video', 'Default Video', videoDefault);

function seedDefault(mediaType, name, options) {
  const exists = db.prepare('SELECT 1 FROM compression_presets WHERE media_type=? LIMIT 1').get(mediaType);
  if (exists) return;
  const stamp = now();
  db.prepare('INSERT INTO compression_presets(id,name,media_type,options_json,is_default,created_at,updated_at) VALUES(?,?,?,?,1,?,?)')
    .run(randomUUID(), name, mediaType, JSON.stringify(options), stamp, stamp);
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
const canceledError = () => Object.assign(new Error('Canceled'), { canceled:true });
const checkCanceled = jobId => {
  const row = db.prepare('SELECT status FROM work_items WHERE id=?').get(jobId);
  if (!row || row.status === 'canceled') throw canceledError();
};

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function updateJob(id, patch = {}) {
  const fields = [];
  const values = [];
  for (const [key, value] of Object.entries(patch)) {
    if (!['status','progress','message','result_json','started_at','finished_at'].includes(key)) continue;
    fields.push(`${key}=?`);
    values.push(value);
  }
  if (!fields.length) return;
  db.prepare(`UPDATE work_items SET ${fields.join(',')} WHERE id=?`).run(...values, id);
}

function parseOptions(text) {
  try { return JSON.parse(text || '{}'); } catch { return {}; }
}

function publicPreset(row) {
  return {
    id:row.id,
    name:row.name,
    mediaType:row.media_type,
    options:parseOptions(row.options_json),
    isDefault:Boolean(row.is_default),
    createdAt:row.created_at,
    updatedAt:row.updated_at
  };
}

function publicJob(row) {
  return {
    id:row.id,
    kind:row.kind,
    originalHash:row.original_hash,
    filename:row.filename,
    mediaType:row.media_type,
    presetId:row.preset_id || '',
    presetName:row.preset_name,
    options:parseOptions(row.options_json),
    status:row.status,
    progress:Number(row.progress) || 0,
    message:row.message,
    result:parseOptions(row.result_json),
    createdAt:row.created_at,
    startedAt:row.started_at,
    finishedAt:row.finished_at
  };
}

function publicRendition(row) {
  if (!row) return null;
  return {
    originalHash:row.original_hash,
    hash:row.rendition_hash,
    mediaType:row.media_type,
    presetId:row.preset_id || '',
    presetName:row.preset_name,
    options:parseOptions(row.options_json),
    mime:row.mime,
    size:Number(row.size) || 0,
    sourceSize:Number(row.source_size) || 0,
    width:Number(row.width) || 0,
    height:Number(row.height) || 0,
    duration:row.duration == null ? null : Number(row.duration),
    createdAt:row.created_at,
    url:`/api/renditions/file?original=${encodeURIComponent(row.original_hash)}`
  };
}

function normalizeImageOptions(raw = {}) {
  const format = ['auto','webp','avif'].includes(String(raw.format || '')) ? String(raw.format) : 'auto';
  const requestedPercent = Math.round(Number(raw.resizePercent) || 0);
  const resizePercent = [25,33,50,75,100].includes(requestedPercent) ? requestedPercent : 0;
  const resizeMax = resizePercent ? 0 : Math.max(0, Math.min(8192, Math.round(Number(raw.resizeMax) || 0)));
  return {
    format,
    quality:Math.round(clamp(raw.quality || (format === 'avif' ? 69 : 90), 1, 100)),
    content:['auto','photo','graphics'].includes(String(raw.content || '')) ? String(raw.content) : 'auto',
    effort:Math.round(clamp(raw.effort ?? 4, 0, format === 'webp' ? 6 : 9)),
    lossless:raw.lossless === true && format === 'webp',
    resizeMax,
    resizePercent
  };
}

function imageTarget(width, height, options) {
  if (options.resizePercent) {
    const scale = Math.min(1, options.resizePercent / 100);
    return { width:Math.max(1, Math.round(width * scale)), height:Math.max(1, Math.round(height * scale)) };
  }
  const max = Number(options.resizeMax) || 0;
  const longest = Math.max(width, height);
  if (!max || longest <= max) return { width, height };
  const scale = max / longest;
  return { width:Math.max(1, Math.round(width * scale)), height:Math.max(1, Math.round(height * scale)) };
}

function runImageWorker(job, cancel) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [IMAGE_WORKER], { windowsHide:true, stdio:['pipe','pipe','pipe'] });
    let stdout = '';
    let stderr = '';
    let canceled = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setInterval(() => {
      if (!cancel()) return;
      canceled = true;
      child.kill();
    }, 200);
    timer.unref?.();
    child.once('error', error => { clearInterval(timer); reject(error); });
    child.once('close', code => {
      clearInterval(timer);
      if (canceled) return reject(canceledError());
      if (code) return reject(new Error(stderr.trim() || `Image encoder exited ${code}`));
      try { resolve(JSON.parse(stdout || '{}')); }
      catch { reject(new Error('Image encoder returned an invalid result')); }
    });
    child.stdin.end(JSON.stringify(job));
  });
}

async function encodeImage(job, candidate, options, sourceInfo) {
  const metadata = await sharp(candidate.path, { failOn:'warning', limitInputPixels:false, animated:false }).metadata();
  if (!metadata.width || !metadata.height) throw new Error('Could not read image dimensions');
  if (Number(metadata.pages || 1) > 1) throw new Error('Animated or multi-page images are not supported yet');
  if (metadata.depth && metadata.depth !== 'uchar') throw new Error("16-bit/HDR images can't be squished safely yet");
  if (String(metadata.space || '').toLowerCase() === 'cmyk') throw new Error("CMYK images can't be squished safely yet");

  const target = imageTarget(Number(metadata.width), Number(metadata.height), options);
  const photo = options.content === 'photo' || (options.content === 'auto' && !metadata.hasAlpha && PHOTO_FORMATS.has(String(metadata.format || '').toLowerCase()));
  const specs = options.format === 'webp'
    ? [{ format:'webp', quality:options.quality, lossless:options.lossless }]
    : options.format === 'avif'
      ? [{ format:'avif', quality:options.quality, lossless:false }]
      : [
          ...(LOSSLESS_FRIENDLY.has(extname(candidate.path).toLowerCase()) ? [{ format:'webp', quality:100, lossless:true }] : []),
          { format:'webp', quality:options.quality, lossless:false },
          { format:'avif', quality:Math.max(1, options.quality - AUTO_AVIF_OFFSET), lossless:false }
        ];
  const outputs = [];
  for (let index = 0; index < specs.length; index++) {
    checkCanceled(job.id);
    const spec = specs[index];
    updateJob(job.id, { progress:10 + index / Math.max(1, specs.length) * 75, message:`Encoding ${spec.format === 'avif' ? 'AVIF' : 'WebP'}` });
    const temp = join(RENDITION_DIR, `.${job.original_hash}-${job.id}-${index}.${spec.format}.tmp`);
    const encoded = await runImageWorker({
      sourcePath:candidate.path,
      outputPath:temp,
      targetWidth:target.width,
      targetHeight:target.height,
      format:spec.format,
      quality:spec.quality,
      lossless:spec.lossless,
      effort:options.effort,
      photo
    }, () => db.prepare('SELECT status FROM work_items WHERE id=?').get(job.id)?.status === 'canceled');
    outputs.push({ ...encoded, ...spec, path:temp });
  }

  const lossless = outputs.find(item => item.lossless && Number(item.size) <= Number(sourceInfo.size) * .90);
  const chosen = lossless || outputs.sort((a,b) => Number(a.size) - Number(b.size))[0];
  if (!chosen) throw new Error('No Squished image was produced');
  const finalPath = join(RENDITION_DIR, `${job.original_hash}.compact.${chosen.format}`);
  await rm(finalPath, { force:true }).catch(() => {});
  await rename(chosen.path, finalPath);
  await Promise.all(outputs.filter(item => item.path !== chosen.path).map(item => rm(item.path, { force:true }).catch(() => {})));
  return {
    path:finalPath,
    hash:String(chosen.hash || await sha256(finalPath)),
    mime:chosen.format === 'avif' ? 'image/avif' : 'image/webp',
    size:Number(chosen.size) || Number((await stat(finalPath)).size),
    width:Number(chosen.width) || target.width,
    height:Number(chosen.height) || target.height,
    duration:null
  };
}

const qFor = quality => {
  const value = clamp(quality, 1, 100);
  if (value >= 72) return Math.max(20, Math.round(30 - (value - 72) * 10 / 28));
  return Math.min(63, Math.round(30 + (72 - value) * 33 / 71));
};

function normalizeVideoOptions(raw = {}) {
  return {
    encoder:['auto','gpu','cpu'].includes(String(raw.encoder || '')) ? String(raw.encoder) : 'auto',
    quality:Math.round(clamp(raw.quality || 72, 1, 100)),
    effort:Math.round(clamp(raw.effort ?? 7, 0, 9)),
    maxEdge:[0,256,426,640,854,1280,1920,2560].includes(Number(raw.maxEdge)) ? Number(raw.maxEdge) : 0,
    fps:[0,5,10,15,30,60].includes(Number(raw.fps)) ? Number(raw.fps) : 0,
    audio:['original','high','normal','small','none'].includes(String(raw.audio || '')) ? String(raw.audio) : 'normal',
    videoBitrateKbps:Number(raw.videoBitrateKbps) >= 10 ? Math.round(clamp(raw.videoBitrateKbps, 10, 250000)) : 0
  };
}

function capture(exe, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide:true, stdio:['ignore','pipe','pipe'] });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, text:`${out}\n${err}` }));
  });
}

async function videoCapabilities() {
  if (ffmpegCaps) return ffmpegCaps;
  const list = [];
  for (const exe of [...new Set([String(process.env.MOCHIMONO_FFMPEG || '').trim(), 'ffmpeg', ffmpegStatic].filter(Boolean))]) {
    try {
      const encoders = await capture(exe, ['-hide_banner','-encoders']);
      if (encoders.code) continue;
      const nv = /\bav1_nvenc\b/.test(encoders.text);
      const svt = /\blibsvtav1\b/.test(encoders.text);
      const aom = /\blibaom-av1\b/.test(encoders.text);
      if (!nv && !svt && !aom) continue;
      let nvHelp = '';
      let svtHelp = '';
      if (nv) nvHelp = (await capture(exe, ['-hide_banner','-h','encoder=av1_nvenc'])).text || '';
      if (svt) svtHelp = (await capture(exe, ['-hide_banner','-h','encoder=libsvtav1'])).text || '';
      list.push({ exe, nv, svt, aom, nvHelp, svtHelp });
    } catch {}
  }
  ffmpegCaps = list;
  return list;
}

const tc = value => {
  const match = /^(\d+):(\d+):([\d.]+)$/.exec(String(value || '').trim());
  return match ? +match[1] * 3600 + +match[2] * 60 + +match[3] : 0;
};

async function probeVideo(path, exe, sourceSize) {
  const text = (await capture(exe, ['-hide_banner','-i',path])).text;
  const lines = text.split(/\r?\n/);
  const video = lines.find(line => /Stream #.*Video:/.test(line)) || '';
  const audio = lines.find(line => /Stream #.*Audio:/.test(line)) || '';
  const duration = tc(/Duration:\s*(\d+:\d+:[\d.]+)/.exec(text)?.[1]);
  const dimensions = /,\s*(\d{2,5})x(\d{2,5})(?:\s|,)/.exec(video);
  const fps = /,\s*([\d.]+)\s*fps(?:,|$)/.exec(video);
  const overall = /Duration:[^\n]*bitrate:\s*(\d+)\s*kb\/s/i.exec(text);
  const audioRate = /Audio:[^\n]*?\s(\d+)\s*kb\/s/i.exec(audio);
  const fallback = duration ? Math.round(Number(sourceSize || 0) * 8 / duration / 1000) : 0;
  const result = {
    width:+dimensions?.[1] || 0,
    height:+dimensions?.[2] || 0,
    duration,
    fps:+fps?.[1] || 0,
    audio:Boolean(audio),
    audioKbps:+audioRate?.[1] || 0,
    audioCodec:/Audio:\s*([^,\s]+)/i.exec(audio)?.[1] || '',
    totalKbps:+overall?.[1] || fallback
  };
  if (!result.width || !result.height || !result.duration) throw new Error('Could not read video metadata with FFmpeg');
  return result;
}

function targetVideoSize(meta, maxEdge) {
  const longest = Math.max(meta.width, meta.height);
  if (!maxEdge || longest <= maxEdge) return { width:meta.width, height:meta.height };
  const scale = maxEdge / longest;
  return { width:Math.max(2, Math.round(meta.width * scale / 2) * 2), height:Math.max(2, Math.round(meta.height * scale / 2) * 2) };
}

function videoRate(meta, target, targetFps, options, sourceSize) {
  const sourceTotal = Math.max(256, Number(meta.totalKbps) || Math.round(sourceSize * 8 / meta.duration / 1000));
  const sourceAudio = meta.audio ? Math.max(24, Number(meta.audioKbps) || Math.min(192, sourceTotal * .08)) : 0;
  let audioKbps = 0;
  if (meta.audio) {
    if (options.audio === 'original') audioKbps = Math.max(24, Math.round(sourceAudio));
    else if (options.audio === 'high') audioKbps = Math.max(48, Math.min(160, Math.round(sourceAudio)));
    else if (options.audio === 'small') audioKbps = Math.max(24, Math.min(48, Math.round(sourceAudio)));
    else if (options.audio !== 'none') audioKbps = Math.max(48, Math.min(128, Math.round(sourceAudio)));
  }
  const sourceVideo = Math.max(160, sourceTotal - sourceAudio);
  const pixelRatio = Math.max(.005, target.width * target.height / Math.max(1, meta.width * meta.height));
  const fpsRatio = meta.fps && targetFps ? Math.min(1, targetFps / meta.fps) : 1;
  const complexity = Math.pow(pixelRatio * fpsRatio, .72);
  const n = options.quality / 100;
  const qualityRatio = n <= .72 ? .12 + (.818 - .12) * (n / .72) : .818 + (.97 - .818) * ((n - .72) / .28);
  const auto = Math.max(10, Math.round(sourceVideo * Math.min(.97, qualityRatio * complexity)));
  const requested = Number(options.videoBitrateKbps) || 0;
  const targetVideoKbps = requested ? Math.max(10, Math.min(Math.round(sourceVideo), requested)) : auto;
  const maxVideoKbps = targetVideoKbps < 80 ? Math.max(targetVideoKbps + 8, Math.round(targetVideoKbps * 1.5)) : Math.max(targetVideoKbps + 48, Math.round(targetVideoKbps * 1.5));
  return { sourceAudio, sourceVideo, audioKbps, targetVideoKbps, maxVideoKbps, bufferKbits:maxVideoKbps * 4 };
}

function hasOption(help, option) {
  return new RegExp(`(?:^|\\s)-?${option}(?:\\s|$|,)`, 'im').test(help || '');
}

function videoPlans(caps, mode) {
  const plans = [];
  if (mode !== 'cpu') for (const item of caps) if (item.nv) plans.push({ exe:item.exe, kind:'nvenc', help:item.nvHelp });
  if (mode !== 'gpu') for (const item of caps) {
    if (item.svt) plans.push({ exe:item.exe, kind:'svt', help:item.svtHelp });
    else if (item.aom) plans.push({ exe:item.exe, kind:'aom', help:'' });
  }
  return plans;
}

function videoEncoderArgs(plan, options, rate, conservative = false) {
  const quality = qFor(options.quality);
  const custom = Number(options.videoBitrateKbps) >= 10;
  if (plan.kind === 'nvenc') {
    const preset = Math.max(1, Math.min(7, Math.round(1 + options.effort / 9 * 6)));
    const uhq = !conservative && /\buhq\b/i.test(plan.help || '');
    const args = ['-c:v','av1_nvenc','-preset',`p${preset}`,'-tune',uhq ? 'uhq' : 'hq','-rc','vbr','-cq',String(quality),'-b:v',`${rate.targetVideoKbps}k`,'-maxrate',`${rate.maxVideoKbps}k`,'-bufsize',`${rate.bufferKbits}k`];
    if (!conservative && hasOption(plan.help, 'highbitdepth')) args.push('-highbitdepth','1');
    if (!conservative && hasOption(plan.help, 'multipass')) args.push('-multipass','fullres');
    if (!conservative && hasOption(plan.help, 'b_ref_mode')) args.push('-bf','5','-b_ref_mode','middle');
    if (!conservative && hasOption(plan.help, 'spatial-aq')) args.push('-spatial-aq','1','-aq-strength','8');
    if (!uhq && !conservative && hasOption(plan.help, 'rc-lookahead')) args.push('-rc-lookahead','20');
    return args;
  }
  if (plan.kind === 'svt') {
    const preset = Math.max(2, Math.min(12, Math.round(12 - options.effort / 9 * 10)));
    const args = ['-c:v','libsvtav1','-crf',String(quality)];
    if (custom) args.push('-b:v',`${rate.targetVideoKbps}k`,'-maxrate',`${rate.maxVideoKbps}k`,'-bufsize',`${rate.bufferKbits}k`);
    args.push('-preset',String(preset),'-pix_fmt','yuv420p10le');
    if (!custom && /svtav1-params/i.test(plan.help || '')) args.push('-svtav1-params',`mbr=${rate.maxVideoKbps}`);
    return args;
  }
  const cpu = Math.max(1, Math.min(8, Math.round(8 - options.effort / 9 * 7)));
  return ['-c:v','libaom-av1','-crf',String(quality),'-b:v',custom ? `${rate.targetVideoKbps}k` : '0','-maxrate',`${rate.maxVideoKbps}k`,'-bufsize',`${rate.bufferKbits}k`,'-cpu-used',String(cpu),'-row-mt','1','-pix_fmt','yuv420p10le'];
}

function runVideo(exe, args, jobId, duration) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide:true, stdio:['ignore','pipe','pipe'] });
    let stderr = '';
    let buffer = '';
    let killed = false;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdout.on('data', chunk => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/); buffer = lines.pop() || '';
      for (const line of lines) if (line.startsWith('out_time=')) {
        const seconds = tc(line.slice(9));
        updateJob(jobId, { progress:Math.max(1, Math.min(99, duration ? seconds / duration * 100 : 0)), message:'Encoding AV1' });
      }
    });
    const timer = setInterval(() => {
      const status = db.prepare('SELECT status FROM work_items WHERE id=?').get(jobId)?.status;
      if (status !== 'canceled') return;
      killed = true;
      child.kill();
    }, 250);
    timer.unref?.();
    child.once('error', error => { clearInterval(timer); reject(error); });
    child.once('close', code => {
      clearInterval(timer);
      if (killed) return reject(canceledError());
      if (code) return reject(new Error(stderr.trim().split(/\r?\n/).slice(-12).join('\n') || `FFmpeg exited ${code}`));
      resolve();
    });
  });
}

async function encodeVideo(job, candidate, options, sourceInfo) {
  const caps = await videoCapabilities();
  const plans = videoPlans(caps, options.encoder);
  if (!plans.length) throw new Error(options.encoder === 'gpu' ? 'No NVIDIA AV1 encoder found' : options.encoder === 'cpu' ? 'No software AV1 encoder found' : 'No AV1 encoder found');
  const meta = await probeVideo(candidate.path, plans[0].exe, sourceInfo.size);
  const target = targetVideoSize(meta, options.maxEdge);
  const targetFps = !options.fps || !meta.fps || meta.fps <= options.fps + .01 ? meta.fps : options.fps;
  const rate = videoRate(meta, target, targetFps, options, sourceInfo.size);
  const matroska = meta.audio && options.audio === 'original';
  const extension = matroska ? 'mkv' : 'webm';
  const temp = join(RENDITION_DIR, `.${job.original_hash}-${job.id}.${extension}.tmp`);
  const filters = [];
  if (target.width !== meta.width || target.height !== meta.height) filters.push(`scale=${target.width}:${target.height}:flags=lanczos`);
  if (targetFps && meta.fps > targetFps + .01) filters.push(`fps=${targetFps}`);

  let lastError;
  for (const plan of plans) {
    for (const conservative of plan.kind === 'nvenc' ? [false,true] : [false]) {
      checkCanceled(job.id);
      await rm(temp, { force:true }).catch(() => {});
      const args = ['-hide_banner','-y','-i',candidate.path,'-map','0:v:0'];
      if (meta.audio && options.audio !== 'none') args.push('-map','0:a:0?');
      args.push('-sn');
      if (filters.length) args.push('-vf',filters.join(','));
      args.push(...videoEncoderArgs(plan, options, rate, conservative));
      const fps = targetFps || meta.fps || 30;
      args.push('-g',String(Math.max(24, Math.round(fps * 2))));
      if (!meta.audio || options.audio === 'none') args.push('-an');
      else if (options.audio === 'original') args.push('-c:a','copy');
      else args.push('-c:a','libopus','-b:a',`${Math.max(24, Math.round(rate.audioKbps || 96))}k`,'-vbr','on','-compression_level','10');
      args.push('-map_metadata','0','-f',matroska ? 'matroska' : 'webm','-progress','pipe:1','-nostats',temp);
      try {
        await runVideo(plan.exe, args, job.id, meta.duration);
        lastError = null;
        break;
      } catch (error) { lastError = error; }
    }
    if (!lastError) break;
    if (options.encoder !== 'auto') break;
  }
  if (lastError) throw lastError;
  checkCanceled(job.id);
  const info = await stat(temp);
  if (!info.isFile() || !info.size) throw new Error('FFmpeg did not produce a Squished video');
  const finalPath = join(RENDITION_DIR, `${job.original_hash}.compact.${extension}`);
  await rm(finalPath, { force:true }).catch(() => {});
  await rename(temp, finalPath);
  return {
    path:finalPath,
    hash:await sha256(finalPath),
    mime:matroska ? 'video/x-matroska' : 'video/webm',
    size:Number(info.size),
    width:target.width,
    height:target.height,
    duration:meta.duration
  };
}

function removeOldRendition(originalHash, keepPath) {
  const old = db.prepare('SELECT path FROM renditions WHERE original_hash=?').get(originalHash);
  if (old?.path && old.path !== keepPath) rm(old.path, { force:true }).catch(() => {});
}

async function execute(job) {
  const candidate = localCandidate(job.original_hash);
  if (!candidate) throw new Error('No local original is currently available');
  const info = await stat(candidate.path).catch(() => null);
  if (!info?.isFile()) throw new Error('Local original is unavailable');
  const extension = extname(candidate.path).toLowerCase();
  if (job.media_type === 'image' && (!IMAGE_EXT.has(extension) || !String(candidate.mime || '').startsWith('image/'))) throw new Error('Unsupported image format');
  if (job.media_type === 'video' && (!VIDEO_EXT.has(extension) || !String(candidate.mime || '').startsWith('video/'))) throw new Error('Unsupported video format');
  const options = job.media_type === 'image' ? normalizeImageOptions(parseOptions(job.options_json)) : normalizeVideoOptions(parseOptions(job.options_json));
  const result = job.media_type === 'image'
    ? await encodeImage(job, candidate, options, info)
    : await encodeVideo(job, candidate, options, info);
  checkCanceled(job.id);

  removeOldRendition(job.original_hash, result.path);
  const stamp = now();
  db.prepare(`INSERT INTO renditions(original_hash,rendition_hash,media_type,preset_id,preset_name,options_json,path,mime,size,source_size,width,height,duration,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(original_hash) DO UPDATE SET rendition_hash=excluded.rendition_hash,media_type=excluded.media_type,preset_id=excluded.preset_id,preset_name=excluded.preset_name,options_json=excluded.options_json,path=excluded.path,mime=excluded.mime,size=excluded.size,source_size=excluded.source_size,width=excluded.width,height=excluded.height,duration=excluded.duration,created_at=excluded.created_at`)
    .run(job.original_hash, result.hash, job.media_type, job.preset_id || null, job.preset_name || '', JSON.stringify(options), result.path, result.mime, result.size, Number(info.size), result.width || 0, result.height || 0, result.duration, stamp);
  invalidateClientProviders();
  return { ...result, sourceSize:Number(info.size), saved:Math.max(0, Number(info.size) - Number(result.size)), presetName:job.preset_name || '' };
}

async function pump() {
  if (activeJob) return;
  const row = db.prepare("SELECT * FROM work_items WHERE status='queued' ORDER BY created_at LIMIT 1").get();
  if (!row) return;
  activeJob = row.id;
  updateJob(row.id, { status:'running', progress:0, message:'Starting', started_at:now(), finished_at:null });
  const job = db.prepare('SELECT * FROM work_items WHERE id=?').get(row.id);
  try {
    const result = await execute(job);
    updateJob(row.id, { status:'done', progress:100, message:'Complete', result_json:JSON.stringify(result), finished_at:now() });
  } catch (error) {
    const current = db.prepare('SELECT status FROM work_items WHERE id=?').get(row.id)?.status;
    if (error?.canceled || current === 'canceled') updateJob(row.id, { status:'canceled', message:'Canceled', finished_at:now() });
    else {
      console.error(error);
      updateJob(row.id, { status:'error', message:error?.message || String(error), finished_at:now() });
    }
  } finally {
    activeJob = null;
    setImmediate(pump);
  }
}
setImmediate(pump);

function presetFor(mediaType, presetId) {
  if (presetId) return db.prepare('SELECT * FROM compression_presets WHERE id=? AND media_type=?').get(presetId, mediaType) || null;
  return db.prepare('SELECT * FROM compression_presets WHERE media_type=? ORDER BY is_default DESC, created_at LIMIT 1').get(mediaType) || null;
}

async function enqueue(body) {
  const hashes = [...new Set((body.hashes || []).map(String).filter(hash => /^[a-f0-9]{64}$/.test(hash)))];
  if (!hashes.length || hashes.length > 5000) throw Object.assign(new Error('Choose between 1 and 5000 files'), { status:400 });
  const created = [];
  const skipped = [];
  for (const hash of hashes) {
    const candidate = localCandidate(hash);
    const mediaType = String(body.mediaType || (String(candidate?.mime || '').startsWith('image/') ? 'image' : String(candidate?.mime || '').startsWith('video/') ? 'video' : ''));
    if (!candidate || !['image','video'].includes(mediaType)) { skipped.push(hash); continue; }
    const preset = body.options && body.mediaType === mediaType ? null : presetFor(mediaType, String(body.presetId || ''));
    if (body.presetId && !preset && !body.options) { skipped.push(hash); continue; }
    const options = body.options && body.mediaType === mediaType ? body.options : parseOptions(preset?.options_json);
    const presetName = String(body.presetName || preset?.name || (mediaType === 'image' ? 'Default Image' : 'Default Video'));
    db.prepare("UPDATE work_items SET status='canceled',message='Superseded',finished_at=? WHERE original_hash=? AND status='queued'").run(now(), hash);
    const id = randomUUID();
    const stamp = now();
    db.prepare('INSERT INTO work_items(id,original_hash,filename,media_type,preset_id,preset_name,options_json,status,created_at) VALUES(?,?,?,?,?,?,?,\'queued\',?)')
      .run(id, hash, candidate.filename || basename(candidate.path), mediaType, preset?.id || body.presetId || null, presetName, JSON.stringify(options || {}), stamp);
    created.push(id);
  }
  setImmediate(pump);
  return { queued:created.length, skipped:skipped.length, jobIds:created, skippedHashes:skipped };
}

async function serveRendition(req, res, row) {
  const info = await stat(row.path).catch(() => null);
  if (!info?.isFile() || Number(info.size) !== Number(row.size)) return json(res, 404, { error:'Squished version is unavailable' });
  const headers = { 'content-type':row.mime, 'accept-ranges':'bytes', 'cache-control':'no-store' };
  const range = String(req.headers.range || '');
  if (!range) {
    res.writeHead(200, { ...headers, 'content-length':info.size });
    if (req.method === 'HEAD') return res.end();
    createReadStream(row.path).pipe(res);
    return;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) { res.writeHead(416, { 'content-range':`bytes */${info.size}` }); return res.end(); }
  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : info.size - 1;
  if (!match[1] && match[2]) { start = Math.max(0, info.size - Number(match[2])); end = info.size - 1; }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= info.size) { res.writeHead(416, { 'content-range':`bytes */${info.size}` }); return res.end(); }
  end = Math.min(end, info.size - 1);
  res.writeHead(206, { ...headers, 'content-range':`bytes ${start}-${end}/${info.size}`, 'content-length':end - start + 1 });
  if (req.method === 'HEAD') return res.end();
  createReadStream(row.path, { start, end }).pipe(res);
}

export async function handleCompressionWorkApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/compression/presets') {
    json(res, 200, { presets:db.prepare('SELECT * FROM compression_presets ORDER BY media_type,is_default DESC,name COLLATE NOCASE').all().map(publicPreset) });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/compression/presets') {
    const body = await readJson(req, 256 * 1024);
    const mediaType = String(body.mediaType || '');
    const name = String(body.name || '').trim().slice(0, 80);
    if (!['image','video'].includes(mediaType) || !name || !body.options || typeof body.options !== 'object') return json(res, 400, { error:'Preset name, type, and settings are required' });
    const existing = db.prepare('SELECT id FROM compression_presets WHERE media_type=? AND name=? COLLATE NOCASE').get(mediaType, name);
    const id = existing?.id || randomUUID();
    const stamp = now();
    if (body.makeDefault === true) db.prepare('UPDATE compression_presets SET is_default=0,updated_at=? WHERE media_type=?').run(stamp, mediaType);
    db.prepare(`INSERT INTO compression_presets(id,name,media_type,options_json,is_default,created_at,updated_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,options_json=excluded.options_json,is_default=excluded.is_default,updated_at=excluded.updated_at`)
      .run(id, name, mediaType, JSON.stringify(body.options), body.makeDefault === true ? 1 : Number(db.prepare('SELECT is_default FROM compression_presets WHERE id=?').get(id)?.is_default || 0), stamp, stamp);
    json(res, 200, { preset:publicPreset(db.prepare('SELECT * FROM compression_presets WHERE id=?').get(id)) });
    return true;
  }
  const defaultPreset = /^\/api\/compression\/presets\/([^/]+)\/default$/.exec(url.pathname);
  if (req.method === 'POST' && defaultPreset) {
    const preset = db.prepare('SELECT * FROM compression_presets WHERE id=?').get(defaultPreset[1]);
    if (!preset) return json(res, 404, { error:'Preset not found' });
    const stamp = now();
    db.prepare('UPDATE compression_presets SET is_default=0,updated_at=? WHERE media_type=?').run(stamp, preset.media_type);
    db.prepare('UPDATE compression_presets SET is_default=1,updated_at=? WHERE id=?').run(stamp, preset.id);
    json(res, 200, { ok:true });
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/work') {
    const rows = db.prepare("SELECT * FROM work_items ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 WHEN 'error' THEN 2 ELSE 3 END, COALESCE(started_at,created_at) DESC LIMIT 300").all();
    const active = rows.filter(row => row.status === 'running').length;
    const queued = rows.filter(row => row.status === 'queued').length;
    json(res, 200, { active, queued, jobs:rows.map(publicJob) });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/work/enqueue') {
    const body = await readJson(req, 4 * 1024 * 1024);
    json(res, 202, await enqueue(body));
    return true;
  }
  const cancel = /^\/api\/work\/([^/]+)\/cancel$/.exec(url.pathname);
  if (req.method === 'POST' && cancel) {
    const row = db.prepare('SELECT status FROM work_items WHERE id=?').get(cancel[1]);
    if (!row || !['queued','running'].includes(row.status)) return json(res, 409, { error:'Work item is not active' });
    updateJob(cancel[1], { status:'canceled', message:'Canceling', finished_at:row.status === 'queued' ? now() : null });
    json(res, 200, { ok:true });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/work/clear-completed') {
    db.exec("DELETE FROM work_items WHERE status IN ('done','error','canceled')");
    json(res, 200, { ok:true });
    return true;
  }
  const rendition = /^\/api\/renditions\/([a-f0-9]{64})$/.exec(url.pathname);
  if (req.method === 'GET' && rendition) {
    const row = db.prepare('SELECT * FROM renditions WHERE original_hash=?').get(rendition[1]);
    const info = row ? await stat(row.path).catch(() => null) : null;
    if (row && (!info?.isFile() || Number(info.size) !== Number(row.size))) return json(res, 200, { rendition:null });
    json(res, 200, { rendition:publicRendition(row) });
    return true;
  }
  if (req.method === 'DELETE' && rendition) {
    const row = db.prepare('SELECT path FROM renditions WHERE original_hash=?').get(rendition[1]);
    if (row?.path) await rm(row.path, { force:true }).catch(() => {});
    db.prepare('DELETE FROM renditions WHERE original_hash=?').run(rendition[1]);
    json(res, 200, { ok:true });
    return true;
  }
  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/api/renditions/file') {
    const hash = String(url.searchParams.get('original') || '');
    if (!/^[a-f0-9]{64}$/.test(hash)) return json(res, 400, { error:'Invalid file' });
    const row = db.prepare('SELECT * FROM renditions WHERE original_hash=?').get(hash);
    if (!row) return json(res, 404, { error:'Squished version not found' });
    await serveRendition(req, res, row);
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/compression/policies') {
    json(res, 200, { policies:db.prepare('SELECT location_id AS locationId,media_type AS mediaType,representation,updated_at AS updatedAt FROM representation_policies ORDER BY location_id,media_type').all() });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/compression/policies') {
    const body = await readJson(req, 128 * 1024);
    const locationId = String(body.locationId || '').trim();
    const mediaType = String(body.mediaType || '');
    const representation = String(body.representation || '');
    if (!locationId || !['image','video'].includes(mediaType) || !['original','compact'].includes(representation)) return json(res, 400, { error:'Location, media type, and representation are required' });
    db.prepare(`INSERT INTO representation_policies(location_id,media_type,representation,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(location_id,media_type) DO UPDATE SET representation=excluded.representation,updated_at=excluded.updated_at`)
      .run(locationId, mediaType, representation, now());
    json(res, 200, { ok:true });
    return true;
  }
  return false;
}
