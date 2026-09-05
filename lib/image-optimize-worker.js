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

async function avifReconstruction(job, width, height, quality, effort) {
  const encoded = await resizedSource(job.sourcePath, width, height)
    .avif({
      quality,
      effort,
      tune: 'iq',
      chromaSubsampling: job.photo ? '4:2:0' : '4:4:4'
    })
    .toBuffer();
  return sharp(encoded, { limitInputPixels:false }).ensureAlpha().raw().toBuffer({ resolveWithObject:true });
}

async function qualityPaintOverlays(job, width, height) {
  if (job.format !== 'avif' || !job.qualityMaskBase64 || !width || !height) return [];

  const maskInput = Buffer.from(String(job.qualityMaskBase64), 'base64');
  if (!maskInput.length) return [];

  const finalQuality = Math.max(1, Math.min(100, Number(job.quality) || 69));
  const lowQuality = Math.max(1, Math.min(Math.max(1, finalQuality - 2), Number(job.qualityLow) || 12));
  // Normal is deliberately automatic: halfway-ish between the destructive
  // Who-cares pre-pass and the untouched High source. This keeps painting to
  // three simple semantic levels without another tuning control.
  const normalQuality = Math.max(lowQuality + 1, Math.min(finalQuality - 1, Math.round(lowQuality + (finalQuality - lowQuality) * 0.55)));
  // These are disposable destructive pre-passes. Spending max final-encode
  // effort on them adds a lot of latency without improving their purpose.
  const prepassEffort = job.effort === 'max' ? 4 : 2;

  const [normalResult, lowResult, maskResult] = await Promise.all([
    avifReconstruction(job, width, height, normalQuality, prepassEffort),
    avifReconstruction(job, width, height, lowQuality, prepassEffort),
    sharp(maskInput, { limitInputPixels:false })
      .resize(width, height, { fit:'fill', kernel:sharp.kernel.cubic })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject:true })
  ]);

  const { data:normal, info:normalInfo } = normalResult;
  const { data:low, info:lowInfo } = lowResult;
  const { data:mask, info:maskInfo } = maskResult;
  if (normalInfo.width !== width || normalInfo.height !== height || normalInfo.channels !== 4 ||
      lowInfo.width !== width || lowInfo.height !== height || lowInfo.channels !== 4) {
    throw new Error('Painted AVIF reconstruction has unexpected dimensions');
  }
  if (maskInfo.width !== width || maskInfo.height !== height || maskInfo.channels < 1) {
    throw new Error('Quality paint mask has unexpected dimensions');
  }

  const maskChannels = maskInfo.channels;
  const pixels = width * height;
  for (let index = 0; index < pixels; index++) {
    const level = mask[index * maskChannels];
    const alphaIndex = index * 4 + 3;

    // Composite order is Normal then Low over the untouched source.
    // 255 = source/High, 128 = fully Normal, 0 = fully Who cares.
    const normalAmount = level <= 128 ? 1 : (255 - level) / 127;
    const lowAmount = level < 128 ? (128 - level) / 128 : 0;
    normal[alphaIndex] = Math.round(normal[alphaIndex] * normalAmount);
    low[alphaIndex] = Math.round(low[alphaIndex] * lowAmount);
  }

  return [
    { input:normal, raw:{ width, height, channels:4 }, blend:'over' },
    { input:low, raw:{ width, height, channels:4 }, blend:'over' }
  ];
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

  const overlays = await qualityPaintOverlays(job, targetWidth, targetHeight);
  if (overlays.length) image = image.composite(overlays);

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
