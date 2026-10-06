import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';

const MAX_BUFFERED_SOURCE = 128 * 1024 * 1024;
let sharpPromise = null;

async function sharpLibrary() {
  if (!sharpPromise) sharpPromise = import('sharp').then(module => {
    const sharp = module.default || module;
    sharp.concurrency(1);
    sharp.cache({ memory: 32, files: 0, items: 24 });
    return sharp;
  });
  return sharpPromise;
}

// Sharp's bundled libvips has no BMP loader. Decode BMP to lossless PNG using
// our existing FFmpeg binary, then use the same WebP encoder as other images.
// This runs in an isolated worker, never on the Agent's HTTP/event-loop thread.
async function decodeBmp(input, edge) {
  const binary = process.env.FFMPEG_PATH || (await import('ffmpeg-static')).default;
  const buffered = Buffer.isBuffer(input);
  const result = spawnSync(binary, [
    '-nostdin','-hide_banner','-loglevel','error','-threads','1','-filter_threads','1',
    '-i', buffered ? 'pipe:0' : input,
    ...(edge > 0 ? ['-vf', `scale=w='min(${edge},iw)':h='min(${edge},ih)':force_original_aspect_ratio=decrease`] : []),
    '-frames:v','1','-c:v','png','-threads','1','-f','image2pipe','pipe:1'
  ], { input:buffered ? input : undefined, windowsHide:true, timeout:15_000, maxBuffer:MAX_BUFFERED_SOURCE });
  if (result.error) throw result.error;
  if (result.status !== 0 || !result.stdout?.length) {
    throw new Error(result.stderr?.toString().trim() || 'BMP contains no decodable image');
  }
  return result.stdout;
}

process.on('message', async message => {
  if (!['thumbnail','stats'].includes(message?.type) || !message.id || !message.input) return;
  let contentHash = '';
  try {
    const sharp = await sharpLibrary();
    let input = message.input;
    if (message.driveRead && typeof input === 'string' && (await stat(input)).size <= MAX_BUFFERED_SOURCE) {
      input = await readFile(input);
      // The original is now in this bounded worker slot. Other same-disk
      // readers can proceed while this process hashes, decodes and encodes.
      process.send?.({ type:'source-read', id:message.id });
      if (message.hashSource) contentHash = createHash('sha256').update(input).digest('hex');
    }
    // Hash the original bytes above, not the intermediate PNG. BMP can also
    // arrive as a buffer without a filename (for example a downloaded object).
    const bmp = Buffer.isBuffer(input) ? input.subarray(0, 2).toString('ascii') === 'BM'
      : typeof input === 'string' && extname(input).toLowerCase() === '.bmp';
    if (bmp) input = await decodeBmp(input, Number(message.edge) || 0);
    if (message.type === 'stats') {
      process.send?.({ id:message.id, ok:true, stats:await sharp(input).stats() });
      return;
    }
    // Oversized inputs stay file-backed and keep their disk lease until the
    // native decoder finishes, rather than buffering an unbounded original.
    let image = sharp(input).rotate();
    if (Number(message.edge) > 0) image = image.resize({
      width:Number(message.edge), height:Number(message.edge), fit:'inside', withoutEnlargement:true
    });
    const { data, info } = await image.webp(message.webp).toBuffer({ resolveWithObject:true });
    const stats = message.checkBlank ? await sharp(data).stats() : null;
    const blank = stats ? stats.channels.slice(0, 3).every(channel => channel.mean < 6) : false;
    process.send?.({
      id: message.id,
      ok: true,
      data,
      info:{ width:Number(info.width) || 0, height:Number(info.height) || 0, blank, contentHash }
    });
  } catch (error) {
    process.send?.({
      id: message.id,
      ok: false,
      code: String(error?.code || ''),
      error:String(error?.message || error),
      contentHash
    });
  }
});

process.on('disconnect', () => process.exit(0));
