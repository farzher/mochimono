const files = document.querySelector('#files');

if (files) {
  const style = document.createElement('style');
  style.textContent = `
.compact-rendition-badge{position:absolute;z-index:5;right:6px;bottom:6px;display:flex;width:18px;height:18px;align-items:center;justify-content:center;border:1px solid rgba(255,255,255,.18);border-radius:6px;background:rgba(17,16,17,.82);color:#e7e1dd;font-size:8px;font-weight:800;line-height:1;box-shadow:0 1px 5px rgba(0,0,0,.3);pointer-events:none}.file-row .compact-rendition-badge{position:static;width:17px;height:17px;margin-left:5px;flex:0 0 auto}.file-card:not(.media-card) .compact-rendition-badge{top:6px;bottom:auto}
`;
  document.head.append(style);

  let running = false;
  let timer = 0;
  const known = new Map();

  async function check(hashes) {
    const response = await fetch('/api/renditions/check', {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ hashes })
    });
    if (!response.ok) return [];
    return (await response.json()).renditions || [];
  }

  function decorate() {
    for (const item of files.querySelectorAll('[data-hash]')) {
      const exists = known.get(item.dataset.hash) === true;
      let badge = item.querySelector(':scope > .compact-rendition-badge');
      if (!exists) {
        badge?.remove();
        continue;
      }
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'compact-rendition-badge';
        badge.textContent = 'C';
        badge.title = 'Compact rendition available';
        item.append(badge);
      }
    }
  }

  async function refresh(force = false) {
    if (running || document.hidden) return;
    const hashes = [...new Set([...files.querySelectorAll('[data-hash]')].map(item => item.dataset.hash).filter(hash => /^[a-f0-9]{64}$/.test(hash)))].slice(0, 2000);
    if (!hashes.length) return;
    const missing = force ? hashes : hashes.filter(hash => !known.has(hash));
    if (!missing.length) return decorate();
    running = true;
    try {
      const found = await check(missing);
      const present = new Set(found.map(item => item.originalHash));
      for (const hash of missing) known.set(hash, present.has(hash));
      decorate();
    } catch {} finally { running = false; }
  }

  function schedule(force = false) {
    clearTimeout(timer);
    timer = setTimeout(() => refresh(force).catch(() => {}), 80);
  }

  window.addEventListener('mochimono:grid-model', () => schedule(false));
  window.addEventListener('mochimono:catalog-updated', () => schedule(false));
  window.addEventListener('mochimono:work-changed', () => { known.clear(); schedule(true); });
  window.addEventListener('scroll', () => schedule(false), { passive:true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(false); });
  setInterval(() => { if (!document.hidden) schedule(false); }, 5000);
  schedule(false);
}
