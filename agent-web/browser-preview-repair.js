const failed = new Set();
const inflight = new Map();
let fallbackPromise = null;

const hashFor = image => image?.closest?.('[data-preview-hash]')?.dataset?.previewHash || '';
const browserCard = image => image?.closest?.('.browser-folder-item');

async function browserFile(hash) {
  await window.mochimonoBrowserFolderShell?.activate?.();
  return window.mochimonoBrowserFolders?.fileForHash?.(hash) || null;
}

async function repair(hash, image) {
  let pending = inflight.get(hash);
  if (!pending) {
    pending = (async () => {
      const file = await browserFile(hash);
      if (!file) throw new Error('Browser source is unavailable');
      fallbackPromise ||= import('/files/browser-thumbnail-fallback.js');
      const { ensureBrowserThumbnail } = await fallbackPromise;
      const mime = String(file.type || '');
      await ensureBrowserThumbnail({
        hash,
        kind:mime.startsWith('video/') ? 'video' : 'image',
        mime,
        filename:file.name || ''
      });
    })().finally(() => inflight.delete(hash));
    inflight.set(hash, pending);
  }
  await pending;
  if (!image.isConnected) return;
  image.src = `/api/thumbs/${encodeURIComponent(hash)}?v=1&r=${Date.now()}`;
}

document.addEventListener('error', event => {
  const image = event.target instanceof HTMLImageElement ? event.target : null;
  if (!image || !browserCard(image)) return;
  const hash = hashFor(image);
  if (!/^[a-f0-9]{64}$/.test(hash) || failed.has(hash) || image.dataset.previewRepair === '1') return;
  image.dataset.previewRepair = '1';
  repair(hash, image).catch(() => {
    failed.add(hash);
    image.dataset.previewRepair = 'failed';
  });
}, true);
