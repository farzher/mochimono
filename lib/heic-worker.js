import { readFile } from 'node:fs/promises';
import { parentPort } from 'node:worker_threads';
import decodeModule from 'heic-decode';
import sharpModule from 'sharp';

const decode = decodeModule?.default || decodeModule;
const sharp = sharpModule?.default || sharpModule;
sharp.concurrency(1);
sharp.cache({ memory: 48, files: 0, items: 8 });

parentPort.on('message', async job => {
  try {
    const input = await readFile(job.path);
    const decoded = await decode({ buffer: input });
    const width = Number(decoded.width) || 0;
    const height = Number(decoded.height) || 0;
    if (!width || !height || !decoded.data?.byteLength) throw new Error('HEIC decoder returned no pixels');

    const pixels = Buffer.from(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength);
    let image = sharp(pixels, { raw: { width, height, channels: 4 } });
    const edge = Number(job.edge) || 0;
    if (edge > 0) image = image.resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true });

    const result = await image.webp({
      quality: Math.max(1, Math.min(100, Number(job.quality) || 82)),
      effort: Math.max(0, Math.min(6, Number(job.effort) || 2)),
      smartSubsample: true
    }).toBuffer({ resolveWithObject: true });

    parentPort.postMessage({
      id: job.id,
      ok: true,
      data: result.data,
      info: { width: Number(result.info.width) || 0, height: Number(result.info.height) || 0 }
    });
  } catch (error) {
    parentPort.postMessage({ id: job.id, ok: false, error: String(error?.message || error) });
  }
});
