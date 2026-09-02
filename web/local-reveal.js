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
    .viewer-reveal-local[data-state="ok"]{color:#9bd7aa!important}
    .viewer-reveal-local[data-state="error"]{color:#ff9d96!important}
  `;
  document.head.append(style);

  let generation = 0;
  let stateTimer = 0;
  let localPath = '';
  const hash = () => viewerOpen.getAttribute('href')?.match(/\/api\/objects\/([a-f0-9]{64})/)?.[1] || '';

  function pathFromLocations(data) {
    const locations = new Map((data.locations || []).map(location => [String(location.id), location]));
    for (const entry of data.files || []) {
      const [, locationId, relativePath] = entry || [];
      const location = locations.get(String(locationId || ''));
      const root = String(location?.rootPath || '').replace(/[\\/]+$/, '');
      const relative = String(relativePath || '').replace(/^[\\/]+/, '');
      if (!root || !relative) continue;
      const separator = root.includes('\\') ? '\\' : '/';
      return `${root}${separator}${relative.replace(/[\\/]+/g, separator)}`;
    }
    return '';
  }

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
    const current = hash();
    const mine = ++generation;
    resetState();
    localPath = '';
    button.hidden = true;
    if (!current || viewer.hidden) return;

    try {
      const response = await fetch(`/api/client/locations?hash=${encodeURIComponent(current)}`, { cache: 'no-store' });
      if (!response.ok) return;
      const data = await response.json();
      if (mine !== generation || current !== hash()) return;
      localPath = pathFromLocations(data);
      button.hidden = !localPath;
    } catch {}
  }

  // Pointer interaction with viewer chrome should not move browser focus away
  // from the viewer itself. That keeps Esc/arrow keyboard navigation reliable
  // after clicking Reveal, Open, navigation arrows, or the overflow menu.
  viewer.addEventListener('mousedown', event => {
    if (event.target.closest('.viewer-bar button,.viewer-bar a,.viewer-bar summary,.viewer-nav')) event.preventDefault();
  }, true);

  // Capture Escape before a focused <button>, <a>, or <details> control gets a
  // chance to consume it. The existing close button remains the single owner of
  // viewer teardown/history behavior.
  window.addEventListener('keydown', event => {
    if (viewer.hidden || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    document.querySelector('#viewer-close')?.click();
  }, true);

  button.addEventListener('click', async event => {
    event.preventDefault();
    event.stopPropagation();
    if (!localPath || button.disabled) return;
    button.disabled = true;
    resetState();
    try {
      const response = await fetch('/api/open-folder', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: localPath, select: true })
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

  new MutationObserver(sync).observe(viewer, { attributes: true, attributeFilter: ['hidden'] });
  new MutationObserver(sync).observe(viewerOpen, { attributes: true, attributeFilter: ['href'] });
  window.addEventListener('mochimono:locations-updated', sync);
  addEventListener('beforeunload', () => clearTimeout(stateTimer), { once: true });
  sync();
}
