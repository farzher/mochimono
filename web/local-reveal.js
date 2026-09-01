const CLIENT = document.documentElement.classList.contains('client-library');
const viewer = document.querySelector('#viewer');
const viewerOpen = document.querySelector('#viewer-open');
const actions = viewer?.querySelector('.viewer-actions');

if (CLIENT && viewer && viewerOpen && actions) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'viewer-action viewer-reveal-local';
  button.hidden = true;
  button.title = 'Show in Explorer';
  button.setAttribute('aria-label', 'Show in Explorer');
  button.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2.7 5.8h5l1.5-1.9h2.5l1.3 1.9h4.3v9.3H2.7z"/><path d="M7.2 10h5.6M10.9 7.7l2.3 2.3-2.3 2.3"/></svg>';
  actions.insertBefore(button, viewerOpen);

  const style = document.createElement('style');
  style.textContent = `
    .viewer-reveal-local{width:34px!important;padding:0!important;display:grid!important;place-items:center!important}
    .viewer-reveal-local[hidden]{display:none!important}
    .viewer-reveal-local svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.35;stroke-linecap:round;stroke-linejoin:round}
  `;
  document.head.append(style);

  let generation = 0;
  const hash = () => viewerOpen.getAttribute('href')?.match(/\/api\/objects\/([a-f0-9]{64})/)?.[1] || '';

  async function sync() {
    const current = hash();
    const mine = ++generation;
    button.hidden = true;
    if (!current || viewer.hidden) return;

    // Newly hashed Browse-only files can already be visible from the staging
    // catalog before the canonical location index is published.
    if (window.mochimonoFastLocalHashes?.has?.(current)) button.hidden = false;

    try {
      const response = await fetch(`/api/client/locations?hash=${encodeURIComponent(current)}`, { cache: 'no-store' });
      if (!response.ok) return;
      const data = await response.json();
      if (mine !== generation || current !== hash()) return;
      if ((data.files || []).length) button.hidden = false;
    } catch {}
  }

  button.addEventListener('click', async event => {
    event.preventDefault();
    event.stopPropagation();
    const current = hash();
    if (!current) return;
    button.disabled = true;
    try {
      const response = await fetch('/api/reveal-file', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hash: current })
      });
      if (!response.ok) button.hidden = true;
    } finally {
      button.disabled = false;
    }
  });

  new MutationObserver(sync).observe(viewer, { attributes: true, attributeFilter: ['hidden'] });
  new MutationObserver(sync).observe(viewerOpen, { attributes: true, attributeFilter: ['href'] });
  window.addEventListener('mochimono:locations-updated', sync);
  window.addEventListener('mochimono:fast-local', sync);
  sync();
}
