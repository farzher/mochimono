const CLIENT = document.documentElement.classList.contains('client-library');
const cached = new Map();
let stopped = false;
let restoreFrame = 0;

function needsRestore() {
  const files = document.querySelector('#files');
  if (!files || !cached.size) return false;
  return !files.querySelector('[data-hash]') && /loading/i.test(files.textContent || '');
}

function paint(items) {
  const library = window.mochimonoLibrary;
  if (!library?.upsertMany || !items.length) return false;
  library.upsertMany(items);
  window.mochimonoFastLocalHashes = new Set(cached.keys());
  window.dispatchEvent(new CustomEvent('mochimono:fast-local', { detail: { count: items.length } }));
  return true;
}

function applyFiles(files) {
  const fresh = [];
  for (const file of files) {
    const hash = String(file?.hash || '');
    if (!hash) continue;
    if (!cached.has(hash)) fresh.push(file);
    cached.set(hash, file);
  }
  if (fresh.length) return paint(fresh);
  if (needsRestore()) return paint([...cached.values()]);
  return false;
}

function scheduleRestore() {
  if (restoreFrame) return;
  restoreFrame = requestAnimationFrame(() => {
    restoreFrame = 0;
    if (needsRestore()) paint([...cached.values()]);
  });
}

async function readFastCatalog() {
  if (!CLIENT || stopped || document.hidden) return;
  try {
    const response = await fetch('/api/client/local-catalog?limit=720', { cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json();
    applyFiles(Array.isArray(data.files) ? data.files : []);
  } catch {}
}

async function fastLocalStart() {
  if (!CLIENT) return;
  const files = document.querySelector('#files');
  if (files) new MutationObserver(scheduleRestore).observe(files, { childList: true, subtree: false });

  await readFastCatalog();
  const started = Date.now();
  const timer = setInterval(() => {
    if (stopped || Date.now() - started > 90_000) {
      stopped = true;
      clearInterval(timer);
      return;
    }
    readFastCatalog();
  }, 750);
  window.addEventListener('beforeunload', () => {
    stopped = true;
    clearInterval(timer);
  }, { once: true });
}

fastLocalStart();
