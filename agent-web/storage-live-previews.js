const frame = document.querySelector('#filesFrame');
const storagePane = document.querySelector('#storagePane');
const folders = document.querySelector('#folders');

if (frame && storagePane && folders) {
  const style = document.createElement('style');
  style.textContent = `
    .storage-folder-sample.live-preview{position:relative;overflow:hidden}
    .storage-folder-sample.live-preview img{width:100%;height:100%;object-fit:cover}
    .storage-folder-sample.live-preview.pending img{opacity:0!important}
  `;
  document.head.append(style);

  const pendingByRoot = new Map();
  const pathKey = value => String(value || '').trim().replaceAll('/', '\\').replace(/[\\]+$/, '').toLowerCase();
  const media = file => String(file?.mime || '').startsWith('image/') || String(file?.mime || '').startsWith('video/');

  function rowPath(row) {
    return String(row?.dataset.folderPath || row?.querySelector('.storage-title strong')?.title || '').trim();
  }

  function installFile(file) {
    if (!media(file) || storagePane.hidden) return false;
    const root = pathKey(file.rootPath);
    if (!root) return false;
    const row = [...folders.querySelectorAll(':scope > [data-folder-path],:scope > [data-browser-folder]')]
      .find(item => pathKey(rowPath(item)) === root);
    const strip = row?.querySelector('.storage-folder-samples');
    if (!strip) return false;
    const hash = String(file.hash || '');
    if (!/^[a-f0-9]{64}$/.test(hash)) return false;
    if (strip.querySelector(`[data-live-hash="${CSS.escape(hash)}"]`) || [...strip.querySelectorAll('img')].some(img => img.src.includes(hash))) return true;

    const cell = document.createElement('span');
    cell.className = `storage-folder-sample live-preview pending${String(file.mime).startsWith('video/') ? ' video' : ''}`;
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
    const load = () => { image.src = `/api/thumbs/${encodeURIComponent(hash)}?v=3&live=${Date.now()}`; };
    image.onload = () => {
      cell.classList.remove('pending');
      cell.classList.add('thumb-ready');
    };
    image.onerror = () => {
      if (++attempts > 6 || storagePane.hidden || !cell.isConnected) return;
      setTimeout(load, Math.min(1200, 180 * 2 ** attempts));
    };

    fetch('/api/thumbs/check', {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ hashes:[hash], background:false })
    }).catch(() => {});
    load();
    return true;
  }

  function flushPending() {
    if (storagePane.hidden) return;
    for (const [root, file] of [...pendingByRoot]) {
      if (installFile(file)) pendingByRoot.delete(root);
    }
  }

  window.addEventListener('click', event => {
    const link = event.target.closest?.('a.storage-source-link');
    if (!link || (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey)) return;
    event.stopImmediatePropagation();
  }, true);

  window.addEventListener('message', event => {
    if (event.source !== frame.contentWindow || event.origin !== location.origin) return;
    if (event.data?.type !== 'mochimono-local-catalog-event') return;
    for (const file of event.data.files || []) {
      if (!media(file)) continue;
      const root = pathKey(file.rootPath);
      if (!root) continue;
      pendingByRoot.set(root, file);
      if (installFile(file)) pendingByRoot.delete(root);
    }
  });

  new MutationObserver(flushPending).observe(storagePane, { attributes:true, attributeFilter:['hidden'] });
  new MutationObserver(flushPending).observe(folders, { childList:true, subtree:true });
}
