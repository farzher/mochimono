const CLIENT = document.documentElement.classList.contains('client-library');

async function fastLocalStart() {
  if (!CLIENT) return;
  try {
    const response = await fetch('/api/client/local-catalog?limit=360', { cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json();
    const files = Array.isArray(data.files) ? data.files : [];
    if (!files.length) return;

    window.mochimonoFastLocalHashes = new Set(files.map(file => String(file.hash)));
    const apply = () => {
      const library = window.mochimonoLibrary;
      if (!library?.upsertMany) return false;
      library.upsertMany(files);
      window.dispatchEvent(new CustomEvent('mochimono:fast-local', { detail: { count: files.length } }));
      return true;
    };

    if (!apply()) {
      let tries = 0;
      const timer = setInterval(() => {
        if (apply() || ++tries > 40) clearInterval(timer);
      }, 25);
    }
  } catch {}
}

fastLocalStart();
