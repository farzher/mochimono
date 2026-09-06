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

function simplificationSeverity(targetQuality, highQuality) {
  const high = Math.max(1, Math.min(100, Number(highQuality) || 69));
  const target = Math.max(1, Math.min(high, Number(targetQuality) || high));
  return Math.max(0, Math.min(1, 1 - target / high));
}

async function simplifiedReconstruction(source, width, height, targetQuality, highQuality) {
  const severity = simplificationSeverity(targetQuality, highQuality);
  if (severity <= 0.01) {
    return { data:Buffer.from(source), info:{ width, height, channels:4 } };
  }

  // Reduce detail in pixel space rather than round-tripping through AVIF.
  // Cubic upsampling is intentionally a little smooth: the final AVIF then
  // sees broad, codec-friendly regions instead of artifacts from another codec.
  const scale = Math.max(0.12, 1 - 0.92 * Math.pow(severity, 0.82));
  const internalWidth = Math.max(1, Math.round(width * scale));
  const internalHeight = Math.max(1, Math.round(height * scale));
  const preBlur = 0.3 + 2.7 * Math.pow(severity, 1.35);
  const postBlur = severity > 0.45
    ? 0.3 + 0.9 * Math.pow((severity - 0.45) / 0.55, 1.2)
    : 0;

  let reduced = sharp(source, { raw:{ width, height, channels:4 }, limitInputPixels:false });
  if (preBlur >= 0.3) reduced = reduced.blur(preBlur);
  if (internalWidth !== width || internalHeight !== height) {
    reduced = reduced.resize(internalWidth, internalHeight, {
      fit:'fill',
      kernel:sharp.kernel.lanczos3
    });
  }
  const small = await reduced.raw().toBuffer({ resolveWithObject:true });

  let expanded = sharp(small.data, {
    raw:{ width:small.info.width, height:small.info.height, channels:4 },
    limitInputPixels:false
  });
  if (small.info.width !== width || small.info.height !== height) {
    expanded = expanded.resize(width, height, {
      fit:'fill',
      kernel:sharp.kernel.cubic
    });
  }
  if (postBlur >= 0.3) expanded = expanded.blur(postBlur);
  return expanded.raw().toBuffer({ resolveWithObject:true });
}

async function encodedNormalQuality(maskInput) {
  // Paint v1 masks are opaque. The UI uses alpha of pixel 0,0 as a tiny
  // metadata byte for the explicit Normal quality (1..100). This leaves the
  // grayscale quality map unchanged and remains backward compatible.
  const pixel = await sharp(maskInput, { limitInputPixels:false })
    .ensureAlpha()
    .extract({ left:0, top:0, width:1, height:1 })
    .raw()
    .toBuffer();
  const value = Number(pixel[3]);
  return value >= 1 && value <= 100 ? value : 0;
}

function dilateBinaryMask(input, width, height, radius) {
  if (radius <= 0) return Buffer.from(input);
  const output = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++) {
    const top = Math.max(0, y - radius);
    const bottom = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x++) {
      const left = Math.max(0, x - radius);
      const right = Math.min(width - 1, x + radius);
      let found = false;
      for (let yy = top; yy <= bottom && !found; yy++) {
        const row = yy * width;
        for (let xx = left; xx <= right; xx++) {
          if (input[row + xx]) {
            found = true;
            break;
          }
        }
      }
      if (found) output[y * width + x] = 255;
    }
  }
  return output;
}

async function qualityInfluenceFields(maskResult, width, height) {
  const maskWidth = maskResult.info.width;
  const maskHeight = maskResult.info.height;
  const maskChannels = maskResult.info.channels;
  if (!maskWidth || !maskHeight || maskChannels < 1) {
    throw new Error('Quality paint mask has unexpected dimensions');
  }

  const maskPixels = maskWidth * maskHeight;
  const highSeed = Buffer.alloc(maskPixels);
  const keepSeed = Buffer.alloc(maskPixels);
  for (let index = 0; index < maskPixels; index++) {
    const level = maskResult.data[index * maskChannels];
    if (level >= 192) highSeed[index] = 255;
    if (level >= 64) keepSeed[index] = 255;
  }

  // Work at paint-mask resolution. A small High expansion protects rough
  // scribbles, then two very different blur widths turn them into importance
  // hints rather than literal cut-out boundaries.
  const shortEdge = Math.max(1, Math.min(maskWidth, maskHeight));
  const highGrow = Math.max(1, Math.min(4, Math.round(shortEdge * 0.012)));
  const highSigma = Math.max(1, Math.min(5, shortEdge * 0.014));
  const keepSigma = Math.max(1, Math.min(12, shortEdge * 0.04));
  const highExpanded = dilateBinaryMask(highSeed, maskWidth, maskHeight, highGrow);

  // Let the wider Keep field inherit the High safety buffer as well, so High
  // naturally falls through Normal before reaching the aggressive low tier.
  const keepBlurSeed = Buffer.alloc(maskPixels);
  for (let index = 0; index < maskPixels; index++) {
    keepBlurSeed[index] = Math.max(keepSeed[index], highExpanded[index]);
  }

  const [highBlurred, keepBlurred] = await Promise.all([
    sharp(highExpanded, { raw:{ width:maskWidth, height:maskHeight, channels:1 }, limitInputPixels:false })
      .blur(highSigma)
      .raw()
      .toBuffer(),
    sharp(keepBlurSeed, { raw:{ width:maskWidth, height:maskHeight, channels:1 }, limitInputPixels:false })
      .blur(keepSigma)
      .raw()
      .toBuffer()
  ]);

  const highFieldMask = Buffer.alloc(maskPixels);
  const keepFieldMask = Buffer.alloc(maskPixels);
  for (let index = 0; index < maskPixels; index++) {
    // Preserve explicit painted cores exactly. The blur only controls falloff.
    highFieldMask[index] = Math.max(highSeed[index], highBlurred[index]);
    keepFieldMask[index] = Math.max(keepSeed[index], keepBlurred[index]);
  }

  const [highField, keepField] = await Promise.all([
    sharp(highFieldMask, { raw:{ width:maskWidth, height:maskHeight, channels:1 }, limitInputPixels:false })
      .resize(width, height, { fit:'fill', kernel:sharp.kernel.cubic })
      .raw()
      .toBuffer({ resolveWithObject:true }),
    sharp(keepFieldMask, { raw:{ width:maskWidth, height:maskHeight, channels:1 }, limitInputPixels:false })
      .resize(width, height, { fit:'fill', kernel:sharp.kernel.cubic })
      .raw()
      .toBuffer({ resolveWithObject:true })
  ]);

  return { highField, keepField, highGrow, highSigma, keepSigma };
}

async function qualityPaintOverlays(job, width, height) {
  if (job.format !== 'avif' || !job.qualityMaskBase64 || !width || !height) return [];

  const maskInput = Buffer.from(String(job.qualityMaskBase64), 'base64');
  if (!maskInput.length) return [];

  const finalQuality = Math.max(1, Math.min(100, Number(job.quality) || 69));
  const lowQuality = Math.max(1, Math.min(finalQuality, Number(job.qualityLow) || 5));
  const fallbackNormal = Math.max(lowQuality, Math.min(finalQuality, Math.round(lowQuality + (finalQuality - lowQuality) * 0.55)));
  const requestedNormal = await encodedNormalQuality(maskInput);
  const normalQuality = Math.max(lowQuality, Math.min(finalQuality, requestedNormal || fallbackNormal));

  // Decode/resize the source once. Normal and Who cares are independent
  // simplifications of these same pixels; neither tier is derived from the other.
  const [sourceResult, maskResult] = await Promise.all([
    resizedSource(job.sourcePath, width, height)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject:true }),
    sharp(maskInput, { limitInputPixels:false })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject:true })
  ]);

  if (sourceResult.info.width !== width || sourceResult.info.height !== height || sourceResult.info.channels !== 4) {
    throw new Error('Quality paint source has unexpected dimensions');
  }

  const [{ data:normal, info:normalInfo }, { data:low, info:lowInfo }, influence] = await Promise.all([
    simplifiedReconstruction(sourceResult.data, width, height, normalQuality, finalQuality),
    simplifiedReconstruction(sourceResult.data, width, height, lowQuality, finalQuality),
    qualityInfluenceFields(maskResult, width, height)
  ]);
  if (normalInfo.width !== width || normalInfo.height !== height || normalInfo.channels !== 4 ||
      lowInfo.width !== width || lowInfo.height !== height || lowInfo.channels !== 4) {
    throw new Error('Painted simplification has unexpected dimensions');
  }

  const { highField, keepField } = influence;
  if (highField.info.width !== width || highField.info.height !== height || highField.info.channels < 1 ||
      keepField.info.width !== width || keepField.info.height !== height || keepField.info.channels < 1) {
    throw new Error('Quality paint influence field has unexpected dimensions');
  }

  const highChannels = highField.info.channels;
  const keepChannels = keepField.info.channels;
  const pixels = width * height;
  for (let index = 0; index < pixels; index++) {
    const highInfluence = highField.data[index * highChannels] / 255;
    const keepInfluence = keepField.data[index * keepChannels] / 255;
    const keepWeight = Math.max(0, Math.min(1, keepInfluence));
    const highWeight = Math.max(0, Math.min(keepWeight, highInfluence));
    const normalWeight = Math.max(0, keepWeight - highWeight);
    const lowWeight = Math.max(0, 1 - keepWeight);

    // Desired final weights are High + Normal + Low = 1, but Sharp composites
    // alpha-over sequentially. With source as the base, then Normal, then Low:
    //   lowAlpha = lowWeight
    //   normalAlpha = normalWeight / (1 - lowAlpha) = normalWeight / keepWeight
    // This gives exact final contributions of highWeight, normalWeight, lowWeight.
    const normalAlpha = keepWeight > 1e-6 ? normalWeight / keepWeight : 0;
    const lowAlpha = lowWeight;
    const alphaIndex = index * 4 + 3;
    normal[alphaIndex] = Math.round(normal[alphaIndex] * normalAlpha);
    low[alphaIndex] = Math.round(low[alphaIndex] * lowAlpha);
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
