if (document.documentElement.classList.contains('client-library')) {
  const root = document.documentElement;
  const files = document.querySelector('#files');
  const empty = document.createElement('div');
  empty.className = 'client-library-empty';
  empty.hidden = true;
  empty.innerHTML = '<button type="button">Open Storage to add files</button>';
  files?.after(empty);

  const style = document.createElement('style');
  style.textContent = `
    html.client-library.library-empty-starting #files>.empty,
    html.client-library.library-empty-global #files>.empty{display:none!important}
    .client-library-empty{min-height:42vh;display:grid;place-items:center}
    .client-library-empty[hidden]{display:none!important}
    .client-library-empty button{border:0;background:transparent;color:#bdb2af;font:600 13px/1.3 Inter,system-ui,sans-serif;cursor:pointer;text-decoration:underline;text-underline-offset:3px}
    .client-library-empty button:hover{color:#fff}
  `;
  document.head.append(style);
  root.classList.add('library-empty-starting');

  empty.querySelector('button')?.addEventListener('click', () => {
    try { parent.document.querySelector('[data-client-tab="storage"]')?.click(); } catch {}
  });

  let timer = 0;
  let settled = false;

  function render() {
    const state = window.mochimonoLibrary?.state?.();
    if (!state) return;
    const loading = window.mochimonoLocalCatalogLoading === true;
    const globallyEmpty = Number(state.total) === 0;
    root.classList.toggle('library-empty-starting', loading || !settled);
    root.classList.toggle('library-empty-global', !loading && settled && globallyEmpty);
    empty.hidden = loading || !(settled && globallyEmpty);
  }

  function settleSoon(delay = 350) {
    clearTimeout(timer);
    if (window.mochimonoLocalCatalogLoading === true) {
      settled = false;
      render();
      return;
    }
    timer = setTimeout(() => {
      if (window.mochimonoLocalCatalogLoading === true) return settleSoon();
      settled = true;
      render();
    }, delay);
  }

  for (const event of ['mochimono:browser-catalog-ready','mochimono:catalog-updated','mochimono:local-catalog-event']) {
    addEventListener(event, () => { render(); settleSoon(); });
  }
  addEventListener('mochimono:local-catalog-loading', () => {
    settled = false;
    render();
  });
  addEventListener('mochimono:local-catalog-ready', () => {
    render();
    settleSoon(0);
  });
  addEventListener('mochimono:browser-folder-sync', event => {
    if (event.detail?.state === 'running') {
      settled = false;
      root.classList.add('library-empty-starting');
      empty.hidden = true;
    } else settleSoon();
  });

  new MutationObserver(render).observe(files || document.body, { childList:true, subtree:false });
  setTimeout(() => settleSoon(0), 1500);
}
