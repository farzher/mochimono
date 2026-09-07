if (location.pathname.startsWith('/files') && window.parent !== window) {
  const NAV_PARAMS = ['view', 'tree', 'source', 'path', 'collection', 'file'];

  function currentParams() {
    const url = new URL(location.href);
    const params = {};
    for (const key of NAV_PARAMS) {
      const value = url.searchParams.get(key);
      if (value != null && value !== '') params[key] = value;
    }
    return params;
  }

  function reportNavigation() {
    window.parent.postMessage({
      type: 'mochimono-navigation-state',
      params: currentParams()
    }, location.origin);
  }

  for (const method of ['pushState', 'replaceState']) {
    const original = history[method].bind(history);
    history[method] = function (...args) {
      const result = original(...args);
      queueMicrotask(reportNavigation);
      return result;
    };
  }

  window.addEventListener('popstate', () => queueMicrotask(reportNavigation));

  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.origin !== location.origin) return;
    if (event.data?.type !== 'mochimono-shell-navigate') return;

    const next = event.data.params && typeof event.data.params === 'object' ? event.data.params : {};
    const url = new URL(location.href);
    for (const key of NAV_PARAMS) url.searchParams.delete(key);
    for (const key of NAV_PARAMS) {
      const value = next[key];
      if (value != null && String(value) !== '') url.searchParams.set(key, String(value));
    }

    if (url.href !== location.href) history.replaceState(history.state, '', url);
    // Existing modules already know how to restore themselves on popstate. Reuse
    // that path for shell Back/Forward instead of maintaining a second router.
    window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
  });

  queueMicrotask(reportNavigation);
}
