const dates = new Map();
window.mochimonoFileDates = dates;

const nativeFetch = window.fetch.bind(window);
window.fetch = async function(input, init) {
  const response = await nativeFetch(input, init);
  try {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.pathname === '/api/catalog' && response.ok) {
      response.clone().json().then(data => {
        for (const file of data.files || []) dates.set(file.hash, {
          fileDate: file.fileDate || file.createdAt,
          addedAt: file.addedAt || file.createdAt
        });
        window.dispatchEvent(new CustomEvent('mochimono-dates-updated'));
      }).catch(() => {});
    }
  } catch {}
  return response;
};

// The Client exposes native added-date sorting through its local app bridge.
// Keep direct Server access useful too: the app already treats unknown date sorts
// as descending, so substitute the added timestamp comparator there.
const nativeSort = Array.prototype.sort;
Array.prototype.sort = function(compare) {
  const select = document.querySelector('#sort');
  if (select?.value === 'date-added' && this.length && this[0]?.hash && this[0]?.addedAt) {
    return nativeSort.call(this, (a, b) => {
      const left = new Date(a?.addedAt || a?.createdAt || 0).getTime() || 0;
      const right = new Date(b?.addedAt || b?.createdAt || 0).getTime() || 0;
      return right - left || String(a?.hash || '').localeCompare(String(b?.hash || ''));
    });
  }
  return nativeSort.call(this, compare);
};

const style = document.createElement('style');
style.textContent = `
  .added-batch-filter{height:30px;padding:0 9px;border:0;border-radius:7px;background:#2c2529;color:#f0b3ad;font:700 11px Inter,system-ui,sans-serif;white-space:nowrap;cursor:pointer}
  .added-batch-filter:hover{background:#392d32;color:#ffc2bb}
`;
document.head.append(style);

let batchId = 0;
let batchHashes = new Set();
let filterButton = null;
let applyFrame = 0;

function sortAdded() {
  const select = document.querySelector('#sort');
  if (!select) return;
  if (window.mochimonoLibrary) return window.mochimonoLibrary.setSort('date-added');
  select.value = 'date-added';
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

function showBatchFilter() {
  if (filterButton) return;
  filterButton = document.createElement('button');
  filterButton.type = 'button';
  filterButton.className = 'added-batch-filter';
  filterButton.textContent = 'Adding now ×';
  filterButton.title = 'Show all files';
  filterButton.onclick = () => window.mochimonoAddedBatch.clear();
  document.querySelector('.commandbar')?.append(filterButton);
}

function applyBatch() {
  applyFrame = 0;
  const copy = new Set(batchHashes);
  if (window.mochimonoLibrary) window.mochimonoLibrary.setBatch(copy);
  else window.mochimonoSetCollectionHashes?.(copy);
}

function scheduleBatch() {
  if (!applyFrame) applyFrame = requestAnimationFrame(applyBatch);
}

window.mochimonoAddedBatch = {
  start(id) {
    batchId = Number(id) || 0;
    batchHashes = new Set();
    showBatchFilter();
    sortAdded();
    scheduleBatch();
  },
  add(hash, file = null) {
    if (!hash) return;
    batchHashes.add(String(hash));
    if (file) {
      dates.set(String(hash), {
        fileDate: file.fileDate || file.createdAt || file.addedAt,
        addedAt: file.addedAt || file.createdAt || file.fileDate
      });
      window.dispatchEvent(new CustomEvent('mochimono-dates-updated'));
      if (window.mochimonoLibrary) window.mochimonoLibrary.upsert(file);
    }
    scheduleBatch();
  },
  async finish() {
    if (!batchId) return;
    filterButton && (filterButton.textContent = `${batchHashes.size.toLocaleString()} added ×`);
    try { await window.mochimonoLibrary?.refresh(); } catch {}
    scheduleBatch();
  },
  clear() {
    batchId = 0;
    batchHashes.clear();
    filterButton?.remove();
    filterButton = null;
    if (window.mochimonoLibrary) window.mochimonoLibrary.setBatch(null);
    else window.mochimonoSetCollectionHashes?.(null);
  }
};
