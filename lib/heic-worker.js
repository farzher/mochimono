import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { parentPort } from 'node:worker_threads';
import ffmpegPath from 'ffmpeg-static';
import decodeModule from 'heic-decode';
import sharpModule from 'sharp';

const decode = decodeModule?.default || decodeModule;
const sharp = sharpModule?.default || sharpModule;
const MAX_FRAME_BYTES = 128 * 1024 * 1024;
sharp.concurrency(1);
sharp.cache({ memory: 48, files: 0, items: 8 });

function outputOptions(job) {
  return {
    quality:Math.max(1, Math.min(100, Number(job.quality) || 82)),
    effort:Math.max(0, Math.min(6, Number(job.effort) || 2))
  };
}

async function encode(image, job) {
  const edge = Number(job.edge) || 0;
  if (edge > 0) image = image.resize({ width:edge, height:edge, fit:'inside', withoutEnlargement:true });
  const options = outputOptions(job);
  return image.webp({ ...options, smartSubsample:true }).toBuffer({ resolveWithObject:true });
}

async function sharpDecode(input, job) {
  return encode(sharp(input).rotate(), job);
}

function ffmpegFrame(path, edge) {
  return new Promise((resolve, reject) => {
    const scale = edge > 0 ? [`scale=w='min(${edge},iw)':h='min(${edge},ih)':force_original_aspect_ratio=decrease`] : [];
    const args = [
      '-nostdin','-hide_banner','-loglevel','error','-threads','1','-filter_threads','1',
      '-i',path,'-an','-sn','-dn',
      ...(scale.length ? ['-vf',scale[0]] : []),
      '-frames:v','1','-c:v','png','-f','image2pipe','pipe:1'
    ];
    const child = spawn(ffmpegPath || 'ffmpeg', args, { windowsHide:true, stdio:['ignore','pipe','pipe'] });
    const chunks = [];
    let bytes = 0;
    let stderr = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error('FFmpeg HEIC decode timed out')); }, 30_000);
    child.stdout.on('data', chunk => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > MAX_FRAME_BYTES) {
        child.kill();
        finish(new Error('FFmpeg HEIC frame is too large'));
      } else chunks.push(chunk);
    });
    child.stderr.on('data', chunk => { if (stderr.length < 64 * 1024) stderr += chunk.toString(); });
    child.on('error', finish);
    child.on('close', code => {
      if (code !== 0 || !bytes) finish(new Error(stderr.trim() || `FFmpeg HEIC decode exited with ${code}`));
      else finish(null, Buffer.concat(chunks));
    });
  });
}

async function ffmpegDecode(path, job) {
  const frame = await ffmpegFrame(path, Number(job.edge) || 0);
  return encode(sharp(frame), { ...job, edge:0 });
}

async function portableDecode(input, job) {
  const decoded = await decode({ buffer:input });
  const width = Number(decoded.width) || 0;
  const height = Number(decoded.height) || 0;
  if (!width || !height || !decoded.data?.byteLength) throw new Error('Portable HEIC decoder returned no pixels');
  const pixels = Buffer.from(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength);
  return encode(sharp(pixels, { raw:{ width, height, channels:4 } }), job);
}

async function render(job) {
  const input = await readFile(job.path);
  const errors = [];
  try { return await sharpDecode(input, job); }
  catch (error) { errors.push(`sharp: ${error?.message || error}`); }
  try { return await ffmpegDecode(job.path, job); }
  catch (error) { errors.push(`ffmpeg: ${error?.message || error}`); }
  try { return await portableDecode(input, job); }
  catch (error) { errors.push(`portable: ${error?.message || error}`); }
  throw new Error(`HEIC decode failed (${errors.join('; ')})`);
}

parentPort.on('message', async job => {
  try {
    const result = await render(job);
    parentPort.postMessage({
      id:job.id,
      ok:true,
      data:result.data,
      info:{ width:Number(result.info.width) || 0, height:Number(result.info.height) || 0 }
    });
  } catch (error) {
    parentPort.postMessage({ id:job.id, ok:false, error:String(error?.message || error) });
  }
});
