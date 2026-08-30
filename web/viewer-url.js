const viewer = document.querySelector('#viewer');
const openLink = document.querySelector('#viewer-open');
const files = document.querySelector('#files');
const rail = document.querySelector('#dateRail');
const CACHE_NAME = 'mochimono-catalog';

function fileParam() {
  return new URL(location.href).searchParams.get('file');
}

function replaceFileParam(hash) {
  const url = new URL(location.href);
  if (hash) url.searchParams.set('file', hash);
  else url.searchParams.delete('file');
  history.replaceState(history.state, '', url);
}

function viewerHash() {
  const match = openLink.getAttribute('href')?.match(/\/api\/objects\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

let wasOpen = false;
function syncUrl() {
  const open = !viewer.hidden;
  if (open) {
    const hash = viewerHash();
    if (hash) replaceFileParam(hash);
  } else if (wasOpen) {
    replaceFileParam('');
  }
  wasOpen = open;
}

new MutationObserver(syncUrl).observe(viewer, {
  subtree: true,
  attributes: true,
  attributeFilter: ['hidden', 'href']
});

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cachedFiles() {
  return new Promise(resolve => {
    const request = indexedDB.open(CACHE_NAME);
    request.onerror = () => resolve([]);
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('files')) {
        db.close();
        resolve([]);
        return;
      }
      const transaction = db.transaction('files');
      const get = transaction.objectStore('files').getAll();
      get.onerror = () => resolve([]);
      get.onsuccess = () => resolve(get.result || []);
      transaction.oncomplete = () => db.close();
    };
  });
}

function dateMs(file) {
  const date = new Date(file.fileDate || file.createdAt || 0).getTime();
  return Number.isNaN(date) ? 0 : date;
}

async function cachedPosition(hash) {
  const catalog = await cachedFiles();
  catalog.sort((a, b) => dateMs(b) - dateMs(a) || String(a.hash).localeCompare(String(b.hash)));
  return { index: catalog.findIndex(file => file.hash === hash), count: catalog.length };
}

function scrubTo(index, count) {
  if (index < 0 || count < 1 || rail.hidden) return false;
  const rect = rail.getBoundingClientRect();
  if (!rect.height) return false;
  const y = rect.top + (count === 1 ? 0 : index / (count - 1)) * rect.height;
  const capture = rail.setPointerCapture;
  const release = rail.releasePointerCapture;
  rail.setPointerCapture = () => {};
  rail.releasePointerCapture = () => {};
  try {
    rail.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientY: y }));
    rail.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientY: y }));
  } finally {
    if (capture) rail.setPointerCapture = capture;
    else delete rail.setPointerCapture;
    if (release) rail.releasePointerCapture = release;
    else delete rail.releasePointerCapture;
  }
  return true;
}

async function restoreViewer() {
  const hash = fileParam();
  if (!hash) return;

  for (let attempt = 0; attempt < 40; attempt++) {
    const card = files.querySelector(`[data-hash="${CSS.escape(hash)}"]`);
    if (card) {
      card.click();
      return;
    }

    if (attempt % 5 === 0) {
      const { index, count } = await cachedPosition(hash);
      if (scrubTo(index, count)) await wait(120);
    }
    await wait(100);
  }
}

restoreViewer().catch(console.warn);
