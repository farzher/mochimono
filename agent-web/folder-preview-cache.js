const folders = document.querySelector('#folders');

let loading = false;
let timer = 0;

const pathKey = value => String(value || '').trim().replace(/[\\/]+$/, '').toLowerCase();

function mediaKind(file) {
  const mime = String(file?.mime || '');
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  return '';
}

function previewFiles(files) {
  const images = [];
  const videos = [];
  const seen = new Set();
  for (const file of Array.isArray(files) ? files : []) {
    const hash = String(file?.hash || '');
    const kind = mediaKind(file);
    if (!/^[a-f0-9]{64}$/.test(hash) || !kind || seen.has(hash)) continue;
    seen.add(hash);
    (kind === 'image' ? images : videos).push(file);
  }
  return [...images, ...videos];
}

function install(cell, file, next) {
  const hash = String(file.hash);
  const img = document.createElement('img');
  img.alt = '';
  img.loading = 'eager';
  img.decoding = 'async';
  img.dataset.folderPreviewHash = hash;
  cell.title = String(file.filename || cell.title || '');
  cell.classList.toggle('video', mediaKind(file) === 'video');

  img.addEventListener('load', () => cell.classList.add('thumb-ready'), { once:true });
  img.addEventListener('error', () => {
    img.remove();
    cell.classList.remove('thumb-ready');
    next();
  }, { once:true });

  // Use the exact content-addressed thumbnail URL used by the Library grid.
  // It can resolve from browser/provider/server cache even when the source drive
  // is currently unavailable.
  img.src = `/api/thumbs/${encodeURIComponent(hash)}`;
  cell.append(img);
}

async function restoreCachedFolderPreviews() {
  if (loading || !folders) return;
  const rows = [...folders.querySelectorAll(':scope > [data-folder-path]')].filter(row => {
    const strip = row.querySelector('.storage-folder-samples');
    return strip && strip.querySelectorAll(':scope > .thumb-ready').length < 3;
  });
  if (!rows.length) return;

  loading = true;
  try {
    const response = await fetch('/api/client/local-catalog?limit=5');
    if (!response.ok) return;
    const data = await response.json();
    const samples = new Map((data.folderSamples || []).map(sample => [pathKey(sample.path), previewFiles(sample.files)]));

    for (const row of rows) {
      const strip = row.querySelector('.storage-folder-samples');
      const files = samples.get(pathKey(row.dataset.folderPath)) || [];
      if (!strip || !files.length) continue;

      let cursor = 0;
      const used = new Set([...strip.querySelectorAll('img[data-folder-preview-hash]')]
        .map(img => img.dataset.folderPreviewHash).filter(Boolean));

      const takeNext = () => {
        while (cursor < files.length) {
          const file = files[cursor++];
          const hash = String(file.hash || '');
          if (!used.has(hash)) {
            used.add(hash);
            return file;
          }
        }
        return null;
      };

      for (const cell of strip.querySelectorAll(':scope > .storage-folder-sample')) {
        if (cell.classList.contains('thumb-ready') || cell.querySelector('img')) continue;
        const fill = () => {
          const file = takeNext();
          if (file) install(cell, file, fill);
        };
        fill();
      }
    }
  } catch {} finally {
    loading = false;
  }
}

function schedule(delay = 120) {
  clearTimeout(timer);
  timer = setTimeout(() => restoreCachedFolderPreviews(), delay);
}

if (folders) {
  new MutationObserver(records => {
    const changed = records.some(record =>
      record.target?.matches?.('.storage-folder-samples') ||
      [...record.addedNodes].some(node => node.nodeType === 1 && (
        node.matches?.('[data-folder-path],.storage-folder-samples') ||
        node.querySelector?.('.storage-folder-samples')
      ))
    );
    if (changed) schedule();
  }).observe(folders, { childList:true, subtree:true });
  schedule(400);
}
