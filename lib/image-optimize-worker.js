import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import sharp from 'sharp';

// Image optimization is intentionally background work. Keep libvips to one
// codec thread in this worker so a slow AVIF/WebP encode cannot consume every
// core that the browser and Mochimono Agent need to stay responsive.
sharp.concurrency(1);
sharp.cache(false);

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function readJob() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return JSON.parse(text || '{}');
}

function resizedSource(path, width, height) {
  let image = sharp(path, { failOn: 'warning', limitInputPixels: false, animated: false });
  if (width && height) {
    image = image.resize(width, height, {
      fit: 'fill',
      kernel: sharp.kernel.lanczos3
    });
  }
  return image;
}

async function qualityPaintOverlay(job, width, height) {
  if (job.format !== 'avif' || !job.qualityMaskBase64 || !width || !height) return null;

  const maskInput = Buffer.from(String(job.qualityMaskBase64), 'base64');
  if (!maskInput.length) return null;
  const lowQuality = Math.max(1, Math.min(50, Number(job.qualityLow) || 12));
  const effort = job.effort === 'max' ? 9 : 4;

  const lowAvif = await resizedSource(job.sourcePath, width, height)
    .avif({
      quality: lowQuality,
      effort,
      tune: 'iq',
      chromaSubsampling: job.photo ? '4:2:0' : '4:4:4'
    })
    .toBuffer();

  const [{ data:overlay, info:overlayInfo }, { data:mask, info:maskInfo }] = await Promise.all([
    sharp(lowAvif, { limitInputPixels: false }).ensureAlpha().raw().toBuffer({ resolveWithObject:true }),
    sharp(maskInput, { limitInputPixels: false })
      .resize(width, height, { fit:'fill', kernel:sharp.kernel.cubic })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject:true })
  ]);

  if (overlayInfo.width !== width || overlayInfo.height !== height || overlayInfo.channels !== 4) {
    throw new Error('Low-quality AVIF reconstruction has unexpected dimensions');
  }
  if (maskInfo.width !== width || maskInfo.height !== height || maskInfo.channels < 1) {
    throw new Error('Quality paint mask has unexpected dimensions');
  }

  const maskChannels = maskInfo.channels;
  const pixels = width * height;
  for (let index = 0; index < pixels; index++) {
    const protectedAmount = mask[index * maskChannels] / 255;
    const alphaIndex = index * 4 + 3;
    overlay[alphaIndex] = Math.round(overlay[alphaIndex] * (1 - protectedAmount));
  }

  return { input:overlay, raw:{ width, height, channels:4 }, blend:'over' };
}

async function encode(job) {
  let image = sharp(job.sourcePath, { failOn: 'warning', limitInputPixels: false, animated: false });
  image = typeof image.keepMetadata === 'function' ? image.keepMetadata() : image.withMetadata();

  const source = await image.metadata();
  const targetWidth = Number(job.targetWidth) || Number(source.width) || 0;
  const targetHeight = Number(job.targetHeight) || Number(source.height) || 0;
  if (targetWidth && targetHeight && (targetWidth !== Number(source.width) || targetHeight !== Number(source.height))) {
    image = image.resize(targetWidth, targetHeight, {
      fit: 'fill',
      kernel: sharp.kernel.lanczos3
    });
  }

  const overlay = await qualityPaintOverlay(job, targetWidth, targetHeight);
  if (overlay) image = image.composite([overlay]);

  if (job.format === 'avif') {
    image = image.avif({
      quality: Number(job.quality) || 69,
      effort: job.effort === 'max' ? 9 : 4,
      tune: 'iq',
      chromaSubsampling: job.photo ? '4:2:0' : '4:4:4'
    });
  } else {
    image = image.webp(job.lossless ? {
      lossless: true,
      effort: job.effort === 'max' ? 6 : 4
    } : {
      quality: Number(job.quality) || 90,
      effort: job.effort === 'max' ? 6 : 4,
      smartSubsample: true
    });
  }

  await image.toFile(job.outputPath);
  const [info, metadata, hash] = await Promise.all([
    stat(job.outputPath),
    sharp(job.outputPath, { limitInputPixels: false }).metadata(),
    sha256(job.outputPath)
  ]);
  if (!info.isFile() || !info.size) throw new Error('Encoder produced an empty file');
  return {
    size: Number(info.size),
    width: Number(metadata.width) || 0,
    height: Number(metadata.height) || 0,
    hash
  };
}

try {
  const job = await readJob();
  const result = await encode(job);
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stderr.write(error?.stack || error?.message || String(error));
  process.exitCode = 1;
}
