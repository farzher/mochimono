const CLIENT = document.documentElement.classList.contains('client-library');
const viewer = document.querySelector('#viewer');
const viewerOpen = document.querySelector('#viewer-open');
const button = document.querySelector('#viewer-reveal-local');

if (CLIENT && viewer && viewerOpen && button) {
  let stateTimer = 0;
  let syncGeneration = 0;
  let hasLocalCopy = false;
  const hash = () => viewerOpen.getAttribute('href')?.match(/\/api\/objects\/([a-f0-9]{64})/)?.[1] || '';

  function resetState() {
    clearTimeout(stateTimer);
    delete button.dataset.state;
    button.title = 'Show in Explorer';
    button.setAttribute('aria-label', 'Show in Explorer');
  }

  function flash(state, message) {
    clearTimeout(stateTimer);
    button.dataset.state = state;
    button.title = message;
    button.setAttribute('aria-label', message);
    stateTimer = setTimeout(resetState, state === 'ok' ? 1400 : 3200);
  }

  async function sync() {
    const generation = ++syncGeneration;
    const current = hash();
    resetState();
    hasLocalCopy = Boolean(current && window.mochimonoLocations?.forHash?.(current)?.length);
    button.hidden = viewer.hidden || !hasLocalCopy;
    if (viewer.hidden || !current || hasLocalCopy) return;

    try {
      const response = await fetch(`/api/client/locations?hash=${encodeURIComponent(current)}`, { cache: 'no-store' });
      const data = response.ok ? await response.json() : null;
      if (generation !== syncGeneration || viewer.hidden || hash() !== current) return;
      hasLocalCopy = Boolean(data?.files?.some(item => item?.[0] === current));
      button.hidden = !hasLocalCopy;
    } catch {}
  }

  viewer.addEventListener('mousedown', event => {
    if (event.target.closest('.viewer-bar button,.viewer-bar a,.viewer-bar summary,.viewer-nav')) event.preventDefault();
  }, true);

  button.addEventListener('click', async event => {
    event.preventDefault();
    event.stopPropagation();
    const current = hash();
    if (!current || !hasLocalCopy || button.disabled) return;
    button.disabled = true;
    resetState();
    try {
      const response = await fetch('/api/reveal-file', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hash: current })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Could not open Explorer (${response.status})`);
      flash('ok', 'Shown in Explorer');
    } catch (error) {
      flash('error', error?.message || 'Could not open Explorer');
    } finally {
      button.disabled = false;
    }
  });

  const viewerObserver = new MutationObserver(sync);
  viewerObserver.observe(viewer, { attributes: true, attributeFilter: ['hidden'] });
  viewerObserver.observe(viewerOpen, { attributes: true, attributeFilter: ['href'] });
  window.addEventListener('mochimono:locations-updated', sync);
  addEventListener('beforeunload', () => clearTimeout(stateTimer), { once: true });
  sync();
}
