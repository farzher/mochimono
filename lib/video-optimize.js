import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, open, rename, rm, stat, unlink, utimes } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { basename, dirname, extname, join } from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import { CONFIG_DIR, json, readJson } from './agent-context.js';
import { invalidateClientProviders } from './client-providers.js';
import { localCandidate } from './local-locations.js';

const DIR = join(CONFIG_DIR, 'video-optimize');
const TTL = 30 * 60e3;
const SAMPLE = 6;
const EXT = new Set(['.mp4','.m4v','.mov','.mkv','.webm','.avi','.mpg','.mpeg','.m2v','.mts','.m2ts','.3gp']);
const sessions = new Map();
let active = 0;
let pending = null;
let capsPromise = null;

await rm(DIR, { recursive:true, force:true }).catch(() => {});
await mkdir(DIR, { recursive:true });

const clamp = (n, a, b) => Math.max(a, Math.min(b, Number(n) || 0));
const exists = async path => Boolean(await stat(path).catch(() => null));
const sameStamp = (info, source) => info?.isFile() && Number(info.size) === Number(source.size) && Math.trunc(info.mtimeMs) === Math.trunc(source.mtimeMs);

// Preserve the current default (Quality 72 ~= CQ/CRF 30), while giving the
// bottom of the slider a genuinely aggressive range down to CQ/CRF 63.
// Lower codec Q means higher visual quality.
const qFor = quality => {
  const value = clamp(quality, 1, 100);
  if (value >= 72) return Math.max(20, Math.round(30 - (value - 72) * 10 / 28));
  return Math.min(63, Math.round(30 + (72 - value) * 33 / 71));
};
const normalizedOptions = raw => ({
  encoder:['auto','gpu','cpu'].includes(String(raw?.encoder || '')) ? String(raw.encoder) : 'auto',
  quality:Math.round(clamp(raw?.quality || 72, 1, 100)),
  effort:Math.round(clamp(raw?.effort ?? 7, 0, 9)),
  maxEdge:[0,256,426,640,854,1280,1920,2560].includes(Number(raw?.maxEdge)) ? Number(raw.maxEdge) : 0,
  fps:[0,5,10,15,30,60].includes(Number(raw?.fps)) ? Number(raw.fps) : 0,
  audio:['original','high','normal','small','none'].includes(String(raw?.audio || '')) ? String(raw.audio) : 'normal'
});

function capture(exe, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide:true, stdio:['ignore','pipe','pipe'] });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, text:`${out}\n${err}` }));
  });
}

function has(help, option) {
  return new RegExp(`(?:^|\\s)-?${option.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}(?:\\s|$|,)`, 'im').test(help || '');
}

async function inspect(exe) {
  const encoders = await capture(exe, ['-hide_banner','-encoders']);
  if (encoders.code) throw Error('probe failed');
  const result = {
    exe,
    nv:/\bav1_nvenc\b/.test(encoders.text),
    svt:/\blibsvtav1\b/.test(encoders.text),
    aom:/\blibaom-av1\b/.test(encoders.text),
    nvHelp:'',
    svtHelp:''
  };
  if (result.nv) result.nvHelp = (await capture(exe, ['-hide_banner','-h','encoder=av1_nvenc']).catch(() => ({ text:'' }))).text || '';
  if (result.svt) result.svtHelp = (await capture(exe, ['-hide_banner','-h','encoder=libsvtav1']).catch(() => ({ text:'' }))).text || '';
  return result;
}

async function caps() {
  if (capsPromise) return capsPromise;
  capsPromise = (async () => {
    const list = [];
    for (const exe of [...new Set([String(process.env.MOCHIMONO_FFMPEG || '').trim(), 'ffmpeg', ffmpegStatic].filter(Boolean))]) {
      try {
        const result = await inspect(exe);
        if (result.nv || result.svt || result.aom) list.push(result);
      } catch {}
    }
    const hardware = list.some(item => item.nv);
    const software = list.some(item => item.svt || item.aom);
    const nv = list.find(item => item.nv);
    return {
      list,
      hardware,
      software,
      preferred:hardware ? 'gpu' : software ? 'cpu' : '',
      gpu:hardware ? `NVIDIA NVENC AV1${nv && /\buhq\b/i.test(nv.nvHelp) ? ' · UHQ' : ''}` : '',
      cpu:list.some(item => item.svt) ? 'SVT-AV1' : list.some(item => item.aom) ? 'libaom AV1' : ''
    };
  })();
  return capsPromise;
}

function plans(capabilities, mode) {
  const result = [];
  if (mode !== 'cpu') {
    for (const item of capabilities.list) if (item.nv) {
      result.push({ exe:item.exe, kind:'nvenc', hardware:true, help:item.nvHelp });
    }
  }
  if (mode !== 'gpu') {
    for (const item of capabilities.list) {
      if (item.svt) result.push({ exe:item.exe, kind:'svt', hardware:false, help:item.svtHelp });
      else if (item.aom) result.push({ exe:item.exe, kind:'aom', hardware:false, help:'' });
    }
  }
  return result;
}

function label(plan) {
  if (plan.kind === 'nvenc') return `NVIDIA NVENC AV1${/\buhq\b/i.test(plan.help) ? ' · UHQ' : ''}`;
  return plan.kind === 'svt' ? 'SVT-AV1' : 'libaom AV1';
}

const tc = value => {
  const match = /^(\d+):(\d+):([\d.]+)$/.exec(String(value || '').trim());
  return match ? +match[1] * 3600 + +match[2] * 60 + +match[3] : 0;
};

async function probe(path, exe, sourceSize) {
  const text = (await capture(exe, ['-hide_banner','-i',path])).text;
  const lines = text.split(/\r?\n/);
  const video = lines.find(line => /Stream #.*Video:/.test(line)) || '';
  const audio = lines.find(line => /Stream #.*Audio:/.test(line)) || '';
  const durationMatch = /Duration:\s*(\d+:\d+:[\d.]+)/.exec(text);
  const dimensionsMatch = /,\s*(\d{2,5})x(\d{2,5})(?:\s|,)/.exec(video);
  const fpsMatch = /,\s*([\d.]+)\s*fps(?:,|$)/.exec(video);
  const overallBitrate = /Duration:[^\n]*bitrate:\s*(\d+)\s*kb\/s/i.exec(text);
  const audioBitrate = /Audio:[^\n]*?\s(\d+)\s*kb\/s/i.exec(audio);
  const codec = /Video:\s*([^,\s]+)/i.exec(video)?.[1] || '';
  const audioCodec = /Audio:\s*([^,\s]+)/i.exec(audio)?.[1] || '';
  const duration = tc(durationMatch?.[1]);
  const fallbackKbps = duration ? Math.round(Number(sourceSize || 0) * 8 / duration / 1000) : 0;
  const result = {
    width:+dimensionsMatch?.[1] || 0,
    height:+dimensionsMatch?.[2] || 0,
    duration,
    fps:+fpsMatch?.[1] || 0,
    audio:Boolean(audio),
    audioKbps:+audioBitrate?.[1] || 0,
    audioCodec,
    totalKbps:+overallBitrate?.[1] || fallbackKbps,
    codec
  };
  if (!result.width || !result.height || !result.duration) {
    throw Object.assign(Error('Could not read video metadata with FFmpeg'), { status:415 });
  }
  return result;
}

function dims(width, height, maxEdge) {
  const longest = Math.max(width, height);
  if (!maxEdge || longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return {
    width:Math.max(2, Math.round(width * scale / 2) * 2),
    height:Math.max(2, Math.round(height * scale / 2) * 2)
  };
}

const fpsTarget = (source, wanted) => !wanted || !source || source <= wanted + .01 ? (source || 0) : wanted;

function ratePlan(session) {
  const sourceTotal = Math.max(256, Number(session.meta.totalKbps) || Math.round(session.source.size * 8 / session.meta.duration / 1000));
  const sourceAudio = session.meta.audio
    ? Math.max(24, Number(session.meta.audioKbps) || Math.min(192, sourceTotal * .08))
    : 0;
  let audioKbps = 0;
  if (session.meta.audio) {
    if (session.options.audio === 'original') audioKbps = Math.max(24, Math.round(sourceAudio));
    else if (session.options.audio === 'high') audioKbps = Math.max(48, Math.min(160, Math.round(sourceAudio)));
    else if (session.options.audio === 'small') audioKbps = Math.max(24, Math.min(48, Math.round(sourceAudio)));
    else if (session.options.audio !== 'none') audioKbps = Math.max(48, Math.min(128, Math.round(sourceAudio)));
  }
  const sourceVideo = Math.max(160, sourceTotal - sourceAudio);
  // Let genuinely tiny resolution/FPS presets receive a genuinely tiny bitrate
  // budget instead of flattening everything below 5% of the original pixel load.
  const pixelRatio = Math.max(.005, (session.target.width * session.target.height) / Math.max(1, session.meta.width * session.meta.height));
  const fpsRatio = session.meta.fps && session.targetFps ? Math.min(1, session.targetFps / session.meta.fps) : 1;
  const complexityScale = Math.pow(pixelRatio * fpsRatio, .72);
  const normalizedQuality = session.options.quality / 100;
  // Preserve the old Quality 72 bitrate target (~81.8% of source video), but
  // let the lower half fall much farther for intentionally tiny encodes.
  const qualityRatio = normalizedQuality <= .72
    ? .12 + (.818 - .12) * (normalizedQuality / .72)
    : .818 + (.97 - .818) * ((normalizedQuality - .72) / .28);
  // CQ remains the visual-quality guardrail. Ultra-low resolution/FPS presets
  // may now reach ~10 kbps instead of being pinned to the old 80 kbps floor.
  const targetVideoKbps = Math.max(10, Math.round(sourceVideo * Math.min(.97, qualityRatio * complexityScale)));
  const maxVideoKbps = targetVideoKbps < 80
    ? Math.max(targetVideoKbps + 8, Math.round(targetVideoKbps * 1.5))
    : Math.max(targetVideoKbps + 48, Math.round(targetVideoKbps * 1.5));
  return {
    sourceTotalKbps:sourceTotal,
    sourceVideoKbps:sourceVideo,
    sourceAudioKbps:sourceAudio,
    audioKbps,
    targetVideoKbps,
    maxVideoKbps,
    bufferKbits:maxVideoKbps * 4
  };
}

function encoderArgs(plan, session, conservative = false) {
  const quality = qFor(session.options.quality);
  const rate = session.rate;
  if (plan.kind === 'nvenc') {
    const preset = Math.max(1, Math.min(7, Math.round(1 + session.options.effort / 9 * 6)));
    const help = plan.help || '';
    const uhq = !conservative && /\buhq\b/i.test(help);
    const args = [
      '-c:v','av1_nvenc',
      '-preset',`p${preset}`,
      '-tune',uhq ? 'uhq' : 'hq',
      '-rc','vbr',
      '-cq',String(quality),
      '-b:v',`${rate.targetVideoKbps}k`,
      '-maxrate',`${rate.maxVideoKbps}k`,
      '-bufsize',`${rate.bufferKbits}k`
    ];

    if (!conservative && has(help, 'highbitdepth')) args.push('-highbitdepth','1');
    if (!conservative && has(help, 'multipass')) args.push('-multipass','fullres');
    if (!conservative && has(help, 'b_ref_mode')) args.push('-bf','5','-b_ref_mode','middle');
    if (!conservative && has(help, 'spatial-aq')) args.push('-spatial-aq','1','-aq-strength','8');
    if (!uhq && !conservative && has(help, 'rc-lookahead')) {
      args.push('-rc-lookahead','20');
      if (has(help, 'lookahead_level')) args.push('-lookahead_level','2');
    }
    return args;
  }

  if (plan.kind === 'svt') {
    const preset = Math.max(2, Math.min(12, Math.round(12 - session.options.effort / 9 * 10)));
    const args = ['-c:v','libsvtav1','-crf',String(quality),'-preset',String(preset),'-pix_fmt','yuv420p10le'];
    if (/svtav1-params/i.test(plan.help || '')) args.push('-svtav1-params',`mbr=${rate.maxVideoKbps}`);
    return args;
  }

  const cpu = Math.max(1, Math.min(8, Math.round(8 - session.options.effort / 9 * 7)));
  return ['-c:v','libaom-av1','-crf',String(quality),'-b:v','0','-maxrate',`${rate.maxVideoKbps}k`,'-cpu-used',String(cpu),'-row-mt','1','-pix_fmt','yuv420p10le'];
}

function finalContainer(session) {
  return session.meta.audio && session.options.audio === 'original' ? 'matroska' : 'webm';
}

function audioArgs(session, sample) {
  if (!session.meta.audio || session.options.audio === 'none') return ['-an'];
  if (!sample && session.options.audio === 'original') return ['-c:a','copy'];
  const kbps = session.options.audio === 'original'
    ? Math.max(48, Math.min(128, Number(session.rate.audioKbps) || 128))
    : Math.max(24, Number(session.rate.audioKbps) || 96);
  return ['-c:a','libopus','-b:a',`${Math.round(kbps)}k`,'-vbr','on','-compression_level','10'];
}

function outputArgs(session, sample) {
  const fps = session.targetFps || session.meta.fps || 30;
  const gop = Math.max(24, Math.round(fps * 2));
  const container = sample ? 'webm' : finalContainer(session);
  return ['-g',String(gop),...audioArgs(session, sample),'-map_metadata','0','-f',container,'-progress','pipe:1','-nostats'];
}

function args(session, out, plan, sample, conservative = false) {
  const result = ['-hide_banner','-y'];
  if (sample && session.sampleStart > 0) result.push('-ss', session.sampleStart.toFixed(3));
  result.push('-i',session.source.path,'-map','0:v:0');
  if (session.meta.audio && session.options.audio !== 'none') result.push('-map','0:a:0?');
  result.push('-sn');
  if (sample) result.push('-t',session.sampleDuration.toFixed(3));

  const filters = [];
  if (session.target.width !== session.meta.width || session.target.height !== session.meta.height) {
    filters.push(`scale=${session.target.width}:${session.target.height}:flags=lanczos`);
  }
  if (session.targetFps && session.meta.fps > session.targetFps + .01) filters.push(`fps=${session.targetFps}`);
  if (filters.length) result.push('-vf',filters.join(','));

  return result.concat(encoderArgs(plan, session, conservative), outputArgs(session, sample), [out]);
}

function run(exe, command, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, command, { windowsHide:true, stdio:['ignore','pipe','pipe'] });
    let err = '';
    let buffer = '';
    child.stderr.setEncoding('utf8');
    child.stdout.setEncoding('utf8');
    child.stderr.on('data', chunk => { err += chunk; });
    child.stdout.on('data', chunk => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) if (line.startsWith('out_time=')) onProgress?.(tc(line.slice(9)));
    });
    child.once('error', reject);
    child.once('close', code => code
      ? reject(Error(err.trim().split(/\r?\n/).slice(-12).join('\n') || `FFmpeg exited ${code}`))
      : resolve());
  });
}

async function encode(session, out, sample, what) {
  const capabilities = await caps();
  const candidates = session.plan ? [session.plan] : plans(capabilities, session.options.encoder);
  if (!candidates.length) {
    throw Object.assign(Error(
      session.options.encoder === 'gpu' ? 'No NVIDIA AV1 encoder found' :
      session.options.encoder === 'cpu' ? 'No software AV1 encoder found' :
      'No AV1 encoder found in system or bundled FFmpeg'
    ), { status:415 });
  }

  let lastError;
  for (const plan of candidates) {
    // First try the full archival profile. NVENC FFmpeg builds differ wildly,
    // so retry the same encoder with a conservative profile before falling back
    // to software or reporting failure.
    const profiles = plan.kind === 'nvenc' ? [false, true] : [false];
    for (const conservative of profiles) {
      try {
        const total = sample ? session.sampleDuration : session.meta.duration;
        session.progress = { label:what, percent:0 };
        await run(plan.exe, args(session, out, plan, sample, conservative), seconds => {
          session.progress = { label:what, percent:Math.max(0, Math.min(99, total ? seconds / total * 100 : 0)) };
          session.updatedAt = Date.now();
        });
        session.plan = plan;
        session.profile = conservative ? 'compatible' : 'archival';
        session.progress = { label:what, percent:100 };
        return plan;
      } catch (error) {
        lastError = error;
        await unlink(out).catch(() => {});
        if (session.options.encoder !== 'auto' && plan.kind !== 'nvenc') break;
      }
    }
    if (session.options.encoder !== 'auto') break;
  }
  throw lastError || Error('AV1 encoding failed');
}

async function hash(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

async function fsync(path) {
  const file = await open(path, 'r+');
  try { await file.sync(); }
  finally { await file.close(); }
}

function sampleAt(at, duration) {
  const length = Math.min(SAMPLE, duration);
  const position = Math.max(0, Math.min(Number(at) || 0, duration));
  return {
    start:Math.max(0, Math.min(duration - length, position - length / 2)),
    len:length
  };
}

function publicTuning(session) {
  const preset = session.plan?.kind === 'nvenc'
    ? `P${Math.max(1, Math.min(7, Math.round(1 + session.options.effort / 9 * 6)))}`
    : session.plan?.kind === 'svt'
      ? `Preset ${Math.max(2, Math.min(12, Math.round(12 - session.options.effort / 9 * 10)))}`
      : '';
  const items = [preset];
  if (session.plan?.kind === 'nvenc' && session.profile === 'archival') {
    if (/\buhq\b/i.test(session.plan.help || '')) items.push('UHQ');
    if (has(session.plan.help, 'highbitdepth')) items.push('10-bit');
    if (has(session.plan.help, 'b_ref_mode')) items.push('B-frame refs');
    if (has(session.plan.help, 'multipass')) items.push('full-res multipass');
    if (has(session.plan.help, 'spatial-aq')) items.push('spatial AQ');
  } else if (session.plan?.kind === 'svt') items.push('10-bit');
  return items.filter(Boolean);
}

async function preview(session) {
  try {
    const capabilities = await caps();
    const probePlan = plans(capabilities, session.options.encoder)[0] || plans(capabilities, 'auto')[0];
    if (!probePlan) throw Object.assign(Error('No AV1-capable FFmpeg build is available'), { status:415 });

    session.progress = { label:'Reading video', percent:0 };
    session.meta = await probe(session.source.path, probePlan.exe, session.source.size);
    session.target = dims(session.meta.width, session.meta.height, session.options.maxEdge);
    session.targetFps = fpsTarget(session.meta.fps, session.options.fps);
    session.rate = ratePlan(session);
    const sample = sampleAt(session.at, session.meta.duration);
    session.sampleStart = sample.start;
    session.sampleDuration = sample.len;

    const out = join(DIR, `${session.id}-preview.webm`);
    const plan = await encode(session, out, true, 'Encoding 6-second preview');
    const info = await stat(out);
    if (!info.isFile() || !info.size) throw Error('FFmpeg did not produce a preview');

    session.preview = { path:out, size:Number(info.size) };
    const bitrateEstimate = Math.round((session.rate.targetVideoKbps + session.rate.audioKbps) * 1000 / 8 * session.meta.duration);
    const sampleEstimate = Math.round(session.preview.size * session.meta.duration / session.sampleDuration);
    // Rate-controlled NVENC should land near the bitrate plan. For unconstrained
    // software fallback, the sample remains the more useful estimate.
    session.estimatedSize = plan.kind === 'nvenc' ? bitrateEstimate : Math.min(sampleEstimate, Math.round(bitrateEstimate * 1.15));
    session.estimatedSaved = session.source.size - session.estimatedSize;
    session.estimatedPercent = session.source.size ? session.estimatedSaved / session.source.size * 100 : 0;
    session.encoder = {
      kind:plan.kind,
      hardware:plan.hardware,
      label:label(plan),
      tuning:publicTuning(session)
    };
    session.status = 'ready';
    session.progress = null;
  } catch (error) {
    session.status = 'error';
    session.error = error?.message || String(error);
    session.progress = null;
  } finally {
    session.updatedAt = Date.now();
    active = Math.max(0, active - 1);
    runPending();
  }
}

function start(session) {
  active++;
  session.status = 'encoding';
  setImmediate(() => preview(session));
}

function queue(session) {
  if (pending && pending.status === 'queued') {
    pending.status = 'superseded';
    sessions.delete(pending.id);
  }
  pending = session;
}

function runPending() {
  if (active || !pending) return;
  const session = pending;
  pending = null;
  if (session.status === 'queued' && sessions.has(session.id)) start(session);
}

async function createSession(hashId, raw, at) {
  if (!/^[a-f0-9]{64}$/.test(hashId)) throw Object.assign(Error('Invalid file'), { status:400 });
  const candidate = localCandidate(hashId);
  if (!candidate) throw Object.assign(Error('Video compression currently requires a local copy'), { status:404 });
  const extension = extname(candidate.path).toLowerCase();
  const info = await stat(candidate.path).catch(() => null);
  if (!EXT.has(extension) || !String(candidate.mime || '').startsWith('video/')) throw Object.assign(Error('Unsupported video format'), { status:415 });
  if (!info?.isFile()) throw Object.assign(Error('Local video is unavailable'), { status:404 });

  const session = {
    id:randomUUID(),
    hash:hashId,
    status:active ? 'queued' : 'starting',
    error:'',
    options:normalizedOptions(raw),
    at:Math.max(0, Number(at) || 0),
    updatedAt:Date.now(),
    meta:null,
    target:null,
    targetFps:0,
    rate:null,
    sampleStart:0,
    sampleDuration:SAMPLE,
    preview:null,
    estimatedSize:0,
    estimatedSaved:0,
    estimatedPercent:0,
    encoder:null,
    plan:null,
    profile:'',
    result:null,
    source:{
      path:candidate.path,
      filename:candidate.filename || basename(candidate.path),
      extension,
      mime:candidate.mime,
      size:Number(info.size),
      mtimeMs:Number(info.mtimeMs),
      atime:info.atime,
      mtime:info.mtime,
      protected:candidate.protected === true
    }
  };
  sessions.set(session.id, session);
  active ? queue(session) : start(session);
  return session;
}

const get = id => {
  const session = sessions.get(String(id || ''));
  if (!session) throw Object.assign(Error('Video compression preview expired'), { status:404 });
  session.updatedAt = Date.now();
  return session;
};

const pub = session => ({
  id:session.id,
  status:session.status,
  error:session.error || '',
  hash:session.hash,
  filename:session.source.filename,
  sourceSize:session.source.size,
  sourceProtected:session.source.protected,
  width:session.meta?.width || 0,
  height:session.meta?.height || 0,
  duration:session.meta?.duration || 0,
  fps:session.meta?.fps || 0,
  hasAudio:Boolean(session.meta?.audio),
  audioCodec:session.meta?.audioCodec || '',
  sourceAudioKbps:session.rate?.sourceAudioKbps || session.meta?.audioKbps || 0,
  targetWidth:session.target?.width || 0,
  targetHeight:session.target?.height || 0,
  targetFps:session.targetFps || 0,
  sampleStart:session.sampleStart || 0,
  sampleDuration:session.sampleDuration || 0,
  options:session.options,
  encoder:session.encoder,
  progress:session.progress,
  rate:session.rate ? {
    targetVideoKbps:session.rate.targetVideoKbps,
    maxVideoKbps:session.rate.maxVideoKbps,
    audioKbps:session.rate.audioKbps,
    sourceTotalKbps:session.rate.sourceTotalKbps
  } : null,
  preview:session.preview ? {
    size:session.preview.size,
    mime:'video/webm',
    url:`/api/video-optimize/file?id=${encodeURIComponent(session.id)}`
  } : null,
  estimatedSize:session.estimatedSize || 0,
  estimatedSaved:session.estimatedSaved || 0,
  estimatedPercent:session.estimatedPercent || 0,
  result:session.result
});

async function serve(req, res, url) {
  const session = get(url.searchParams.get('id'));
  const path = session.preview?.path;
  const info = path ? await stat(path).catch(() => null) : null;
  if (!info?.isFile()) throw Object.assign(Error('Compressed preview is unavailable'), { status:404 });
  const headers = { 'content-type':'video/webm', 'accept-ranges':'bytes', 'cache-control':'no-store' };
  const range = String(req.headers.range || '');
  if (!range) {
    res.writeHead(200, { ...headers, 'content-length':info.size });
    return req.method === 'HEAD' ? res.end() : createReadStream(path).pipe(res);
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    res.writeHead(416, { 'content-range':`bytes */${info.size}` });
    return res.end();
  }
  let start = match[1] ? +match[1] : 0;
  let end = match[2] ? +match[2] : info.size - 1;
  if (!match[1] && match[2]) {
    start = Math.max(0, info.size - +match[2]);
    end = info.size - 1;
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= info.size) {
    res.writeHead(416, { 'content-range':`bytes */${info.size}` });
    return res.end();
  }
  end = Math.min(end, info.size - 1);
  res.writeHead(206, { ...headers, 'content-range':`bytes ${start}-${end}/${info.size}`, 'content-length':end-start+1 });
  return req.method === 'HEAD' ? res.end() : createReadStream(path, { start, end }).pipe(res);
}

async function keepPath(path, targetExtension) {
  const extension = extname(path);
  const stem = path.slice(0, -extension.length);
  let target = extension.toLowerCase() === targetExtension ? `${stem}.compressed${targetExtension}` : `${stem}${targetExtension}`;
  if (!await exists(target)) return target;
  for (let index=2; index<1000; index++) {
    target = `${stem}.compressed-${index}${targetExtension}`;
    if (!await exists(target)) return target;
  }
  throw Error('Could not choose an output filename');
}

async function place(session, out, mode) {
  const info = await stat(out);
  const digest = await hash(out);
  const source = session.source.path;
  const extension = extname(source);
  const stem = source.slice(0, -extension.length);
  const container = finalContainer(session);
  const targetExtension = container === 'matroska' ? '.mkv' : '.webm';
  const final = mode === 'keep' ? await keepPath(source, targetExtension) : extension.toLowerCase() === targetExtension ? source : `${stem}${targetExtension}`;
  if (mode === 'replace' && final !== source && await exists(final)) throw Object.assign(Error(`${basename(final)} already exists`), { status:409 });

  const directory = dirname(source);
  const stage = join(directory, `.${basename(final)}.mochimono-${session.id}.tmp`);
  const backup = join(directory, `.${basename(source)}.mochimono-original-${session.id}.tmp`);
  await unlink(stage).catch(() => {});
  await unlink(backup).catch(() => {});
  await copyFile(out, stage);
  await fsync(stage);
  if (await hash(stage) !== digest) {
    await unlink(stage).catch(() => {});
    throw Error('Compressed copy failed verification');
  }
  await utimes(stage, session.source.atime, session.source.mtime).catch(() => {});

  if (mode === 'keep') await rename(stage, final);
  else {
    let placed = false;
    await rename(source, backup);
    try {
      await rename(stage, final);
      placed = true;
      const finalInfo = await stat(final);
      if (!finalInfo.isFile() || Number(finalInfo.size) !== Number(info.size)) throw Error('Replacement failed verification');
      await utimes(final, session.source.atime, session.source.mtime).catch(() => {});
      await unlink(backup);
    } catch (error) {
      if (placed) await unlink(final).catch(() => {});
      await rename(backup, source).catch(() => {});
      await unlink(stage).catch(() => {});
      throw error;
    }
  }

  return {
    mode,
    path:final,
    filename:basename(final),
    size:Number(info.size),
    hash:digest,
    saved:Math.max(0, session.source.size - Number(info.size)),
    format:'av1',
    container:container === 'matroska' ? 'mkv' : 'webm',
    audioMode:session.options.audio,
    audioCodec:session.options.audio === 'original' ? session.meta.audioCodec : session.meta.audio ? 'opus' : '',
    width:session.target.width,
    height:session.target.height,
    fps:session.targetFps || session.meta.fps,
    encoder:session.encoder
  };
}

async function commit(session, mode) {
  const container = finalContainer(session);
  const out = join(DIR, `${session.id}-full.${container === 'matroska' ? 'mkv' : 'webm'}`);
  try {
    session.progress = { label:'Encoding full video', percent:0 };
    const current = await stat(session.source.path).catch(() => null);
    if (!sameStamp(current, session.source)) throw Object.assign(Error('The original changed while the preview was open. Generate a new preview first.'), { status:409 });
    await encode(session, out, false, 'Encoding full video');
    session.result = await place(session, out, mode);
    session.status = 'committed';
    session.progress = null;
    invalidateClientProviders();
  } catch (error) {
    session.status = 'error';
    session.error = error?.message || String(error);
    session.progress = null;
  } finally {
    session.updatedAt = Date.now();
    await unlink(out).catch(() => {});
    active = Math.max(0, active - 1);
    runPending();
  }
}

function startCommit(session, mode) {
  if (session.status !== 'ready') throw Object.assign(Error('Video compression preview is not ready'), { status:409 });
  if (!['keep','replace'].includes(mode)) throw Object.assign(Error('Choose Keep copy or Replace original'), { status:400 });
  session.status = 'committing';
  session.progress = { label:'Starting full AV1 encode', percent:0 };
  active++;
  setImmediate(() => commit(session, mode));
}

setInterval(() => {
  const cutoff = Date.now() - TTL;
  for (const [id, session] of sessions) {
    if (session.updatedAt < cutoff && !['encoding','queued','committing'].includes(session.status)) {
      sessions.delete(id);
      unlink(session.preview?.path || '').catch(() => {});
    }
  }
}, 60e3).unref?.();

export async function handleVideoOptimizeApi(req, res, url) {
  if (!url.pathname.startsWith('/api/video-optimize/')) return false;

  if (req.method === 'GET' && url.pathname === '/api/video-optimize/capabilities') {
    const capabilities = await caps();
    json(res, 200, {
      available:Boolean(capabilities.preferred),
      hardware:capabilities.hardware,
      software:capabilities.software,
      preferred:capabilities.preferred,
      gpu:capabilities.gpu,
      cpu:capabilities.cpu
    });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/video-optimize/start') {
    const body = await readJson(req, 32768);
    const session = await createSession(String(body.hash || ''), body.options || {}, body.at);
    json(res, 202, pub(session));
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/video-optimize/status') {
    json(res, 200, pub(get(url.searchParams.get('id'))));
    return true;
  }
  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/api/video-optimize/file') {
    await serve(req, res, url);
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/video-optimize/commit') {
    const body = await readJson(req, 32768);
    const session = get(body.id);
    startCommit(session, String(body.mode || ''));
    json(res, 202, pub(session));
    return true;
  }

  json(res, 404, { error:'Not found' });
  return true;
}
