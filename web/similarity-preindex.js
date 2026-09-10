const sort = document.querySelector('#sort');
const root = document.documentElement;
let replaying = false;
let worker = null;
let generation = 0;

function imageHashes() {
  return [...new Set((window.mochimonoGridModel?.items || [])
    .filter(item => item?.[2] === 'image')
    .map(item => String(item?.[0] || ''))
    .filter(hash => /^[a-f0-9]{64}$/.test(hash)))];
}

function progressUi(done, total) {
  const bar = document.querySelector('.similarity-sort-bar');
  if (!bar) return;
  bar.hidden = false;
  const status = bar.querySelector('.similarity-sort-copy > span');
  const progress = bar.querySelector('.similarity-sort-progress > i');
  if (status) status.textContent = `Preparing visual index · ${done.toLocaleString()} / ${total.toLocaleString()}`;
  if (progress) progress.style.width = `${total ? Math.max(2, Math.min(100, done / total * 100)) : 0}%`;
}

function cancel() {
  generation++;
  worker?.terminate();
  worker = null;
  root.classList.remove('similarity-preindexing');
}

function prepare(hashes, mine) {
  return new Promise((resolve, reject) => {
    worker?.terminate();
    const current = new Worker(new URL('./similarity-fingerprint-worker.js', import.meta.url), { type:'module' });
    worker = current;
    current.onerror = event => {
      if (worker === current) worker = null;
      reject(new Error(event.message || 'Similarity pre-index failed'));
    };
    current.onmessage = event => {
      if (mine !== generation) return;
      const data = event.data || {};
      if (data.type === 'progress') {
        progressUi(Number(data.done) || 0, Number(data.total) || hashes.length);
        return;
      }
      if (data.type === 'error') {
        if (worker === current) worker = null;
        current.terminate();
        reject(new Error(data.error || 'Similarity pre-index failed'));
        return;
      }
      if (data.type !== 'ready') return;
      if (worker === current) worker = null;
      current.terminate();
      resolve();
    };
    current.postMessage({ hashes });
  });
}

sort?.addEventListener('change', event => {
  if (replaying) return;
  if (sort.value !== 'similar') {
    cancel();
    return;
  }

  const hashes = imageHashes();
  if (!hashes.length) return;
  event.preventDefault();
  event.stopImmediatePropagation();

  const mine = ++generation;
  root.classList.add('similarity-preindexing');
  progressUi(0, hashes.length);
  prepare(hashes, mine).catch(() => {}).finally(() => {
    if (mine !== generation) return;
    worker = null;
    root.classList.remove('similarity-preindexing');
    if (sort.value !== 'similar') return;
    replaying = true;
    try { sort.dispatchEvent(new Event('change', { bubbles:true })); }
    finally { replaying = false; }
  });
}, true);

addEventListener('beforeunload', cancel, { once:true });
