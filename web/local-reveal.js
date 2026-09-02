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

  let stateTimer = 0;
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

  function sync() {
    const current = hash();
    if (!viewer.hidden && window.mochimonoViewerPerformance?.defer?.(sync)) return;
    resetState();
    hasLocalCopy = Boolean(current && window.mochimonoLocations?.forHash?.(current)?.length);
    button.hidden = viewer.hidden || !hasLocalCopy;
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

  new MutationObserver(sync).observe(viewer, { attributes: true, attributeFilter: ['hidden'] });
  new MutationObserver(sync).observe(viewerOpen, { attributes: true, attributeFilter: ['href'] });
  window.addEventListener('mochimono:locations-updated', sync);
  addEventListener('beforeunload', () => clearTimeout(stateTimer), { once: true });
  sync();
}
