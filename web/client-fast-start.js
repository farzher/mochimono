const CLIENT = document.documentElement.classList.contains('client-library');
const known = new Set();
let stopped = false;

function applyFiles(files) {
  const fresh = files.filter(file => file?.hash && !known.has(String(file.hash)));
  if (!fresh.length) return false;
  const library = window.mochimonoLibrary;
  if (!library?.upsertMany) return false;
  fresh.forEach(file => known.add(String(file.hash)));
  window.mochimonoFastLocalHashes = new Set(known);
  library.upsertMany(fresh);
  window.dispatchEvent(new CustomEvent('mochimono:fast-local', { detail: { count: fresh.length } }));
  return true;
}

async function readFastCatalog() {
  if (!CLIENT || stopped || document.hidden) return;
  try {
    const response = await fetch('/api/client/local-catalog?limit=720', { cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json();
    const files = Array.isArray(data.files) ? data.files : [];
    if (!applyFiles(files) && files.length) {
      // app.js may still be establishing window.mochimonoLibrary. Retry on the
      // next short poll without marking these hashes as consumed.
    }
  } catch {}
}

async function fastLocalStart() {
  if (!CLIENT) return;
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
