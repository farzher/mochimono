const frame = document.querySelector('#filesFrame');
const storagePane = document.querySelector('#storagePane');
const folders = document.querySelector('#folders');

if (frame && storagePane && folders) {
  const style = document.createElement('style');
  style.textContent = `
    .storage-folder-sample.live-preview{position:relative;overflow:hidden}
    .storage-folder-sample.live-preview img{width:100%;height:100%;object-fit:cover}
    .storage-folder-sample.live-preview.pending img{opacity:0}
  `;
  document.head.append(style);

  const pathKey = value => String(value || '').trim().replaceAll('/', '\\').replace(/[\\]+$/, '').toLowerCase();
  const media = file => String(file?.mime || '').startsWith('image/') || String(file?.mime || '').startsWith('video/');

  function rowPath(row) {
    return String(row?.dataset.folderPath || row?.querySelector('.storage-title strong')?.title || '').trim();
  }

  function previewForRow(row) {
    return row?.querySelector('.storage-folder-samples') || null;
  }

  function installFile(file) {
    if (!media(file) || storagePane.hidden) return;
    const root = pathKey(file.rootPath);
    if (!root) return;
    const row = [...folders.querySelectorAll(':scope > [data-folder-path],:scope > [data-browser-folder]')]
      .find(item => pathKey(rowPath(item)) === root);
    const strip = previewForRow(row);
    if (!strip) return;
    const hash = String(file.hash || '');
    if (!/^[a-f0-9]{64}$/.test(hash) || strip.querySelector(`[data-live-hash="${CSS.escape(hash)}"]`)) return;

    const cell = document.createElement('span');
    cell.className = 'storage-folder-sample live-preview pending';
    cell.dataset.liveHash = hash;
    cell.title = file.filename || '';
    const image = document.createElement('img');
    image.alt = '';
    image.decoding = 'async';
    image.draggable = false;
    cell.append(image);
    strip.prepend(cell);
    while (strip.children.length > 3) strip.lastElementChild?.remove();

    let attempts = 0;
    const load = () => {
      image.src = `/api/thumbs/${encodeURIComponent(hash)}?v=3&live=${Date.now()}`;
    };
    image.onload = () => cell.classList.remove('pending');
    image.onerror = () => {
      if (++attempts > 6 || storagePane.hidden || !cell.isConnected) return;
      setTimeout(load, Math.min(1200, 180 * 2 ** attempts));
    };

    // Thumbnail generation is demand-driven: only request it because Storage is
    // visible and the new file has just entered one of its three preview slots.
    fetch('/api/thumbs/check', {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ hashes:[hash], background:false })
    }).catch(() => {});
    load();
  }

  window.addEventListener('message', event => {
    if (event.source !== frame.contentWindow || event.origin !== location.origin) return;
    if (event.data?.type !== 'mochimono-local-catalog-event') return;
    for (const file of event.data.files || []) installFile(file);
  });
}
