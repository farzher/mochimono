const inflight = new Map();
const attempts = new Map();
let fallbackPromise = null;

const MAX_ATTEMPTS = 3;
const hashFor = image => image?.closest?.('[data-preview-hash]')?.dataset?.previewHash || '';
const browserCard = image => image?.closest?.('.browser-folder-item');
const extension = name => String(name || '').toLowerCase().match(/\.([^.]+)$/)?.[1] || '';
const VIDEO_EXT = new Set(['mp4','m4v','mov','mkv','webm','avi','mpg','mpeg','m2v','mts','m2ts','3gp']);
const MIME = new Map([
  ['jpg','image/jpeg'],['jpeg','image/jpeg'],['png','image/png'],['gif','image/gif'],['webp','image/webp'],['heic','image/heic'],['heif','image/heif'],['avif','image/avif'],['bmp','image/bmp'],['tif','image/tiff'],['tiff','image/tiff'],
  ['mp4','video/mp4'],['m4v','video/mp4'],['mov','video/quicktime'],['mkv','video/x-matroska'],['webm','video/webm'],['avi','video/x-msvideo'],['mpg','video/mpeg'],['mpeg','video/mpeg'],['m2v','video/mpeg'],['mts','video/mp2t'],['m2ts','video/mp2t'],['3gp','video/3gpp']
]);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function browserFile(hash) {
  await window.mochimonoBrowserFolderShell?.activate?.();
  try { return await window.mochimonoBrowserFolders?.fileForHash?.(hash) || null; }
  catch { return null; }
}

function waitForImage(image, src) {
  return new Promise((resolve, reject) => {
    if (!image?.isConnected) return reject(new Error('Preview left the page'));
    const done = error => {
      image.removeEventListener('load', loaded);
      image.removeEventListener('error', failed);
      error ? reject(error) : resolve();
    };
    const loaded = () => done();
    const failed = () => done(new Error('Repaired preview did not load'));
    image.addEventListener('load', loaded, { once:true });
    image.addEventListener('error', failed, { once:true });
    image.src = src;
  });
}

async function generate(hash) {
  const file = await browserFile(hash);
  if (!file) throw new Error('Browser source is unavailable');
  fallbackPromise ||= import('/files/browser-thumbnail-fallback.js');
  const { ensureBrowserThumbnail } = await fallbackPromise;
  const ext = extension(file.name);
  const mime = String(file.type || MIME.get(ext) || 'application/octet-stream');
  const kind = mime.startsWith('video/') || VIDEO_EXT.has(ext) ? 'video' : 'image';
  await ensureBrowserThumbnail({ hash, kind, mime, filename:file.name || '' });
}

async function repair(hash, image) {
  let pending = inflight.get(hash);
  if (!pending) {
    pending = (async () => {
      let lastError;
      for (let attempt = (attempts.get(hash) || 0) + 1; attempt <= MAX_ATTEMPTS; attempt++) {
        attempts.set(hash, attempt);
        try {
          await generate(hash);
          await waitForImage(image, `/api/thumbs/${encodeURIComponent(hash)}?v=1&r=${Date.now()}`);
          attempts.delete(hash);
          if (image.isConnected) delete image.dataset.previewRepair;
          return;
        } catch (error) {
          lastError = error;
          if (attempt < MAX_ATTEMPTS) await sleep(250 * attempt);
        }
      }
      throw lastError || new Error('Could not repair preview');
    })().finally(() => inflight.delete(hash));
    inflight.set(hash, pending);
  }
  return pending;
}

document.addEventListener('load', event => {
  const image = event.target instanceof HTMLImageElement ? event.target : null;
  if (!image || !browserCard(image)) return;
  const hash = hashFor(image);
  if (hash) attempts.delete(hash);
  delete image.dataset.previewRepair;
}, true);

document.addEventListener('error', event => {
  const image = event.target instanceof HTMLImageElement ? event.target : null;
  if (!image || !browserCard(image)) return;
  const hash = hashFor(image);
  if (!/^[a-f0-9]{64}$/.test(hash) || image.dataset.previewRepair === '1') return;
  image.dataset.previewRepair = '1';
  repair(hash, image).catch(() => {
    if (image.isConnected) image.dataset.previewRepair = 'failed';
  });
}, true);

window.addEventListener('mochimono:browser-folders-changed', () => {
  attempts.clear();
  for (const image of document.querySelectorAll('.browser-folder-item img[data-preview-repair="failed"]')) {
    delete image.dataset.previewRepair;
    image.src = `${image.src.split('?')[0]}?r=${Date.now()}`;
  }
});
