if (document.documentElement.classList.contains('client-library')) {
  const nativeFetch = window.fetch.bind(window);
  const cloudSessions = new Set();

  function requestUrl(input) {
    try {
      const value = typeof input === 'string' || input instanceof URL ? input : input?.url;
      return new URL(value, location.href);
    } catch { return null; }
  }

  function requestMethod(input, init) {
    return String(init?.method || (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')).toUpperCase();
  }

  function requestBody(init) {
    if (typeof init?.body !== 'string') return null;
    try { return JSON.parse(init.body); }
    catch { return null; }
  }

  async function errorMessage(response) {
    try { return String((await response.clone().json()).error || ''); }
    catch { return ''; }
  }

  async function rememberCloudSession(response) {
    if (!response.ok) return response;
    try {
      const data = await response.clone().json();
      if (data.id) cloudSessions.add(String(data.id));
    } catch {}
    return response;
  }

  window.fetch = async (input, init = {}) => {
    const url = requestUrl(input);
    if (!url || url.origin !== location.origin) return nativeFetch(input, init);
    const method = requestMethod(input, init);

    if (url.pathname === '/api/image-optimize/start' && method === 'POST') {
      const response = await nativeFetch(input, init);
      if (response.status !== 404 || !/requires a local copy/i.test(await errorMessage(response))) return response;
      return rememberCloudSession(await nativeFetch('/api/image-optimize/cloud-start', init));
    }

    if (url.pathname === '/api/image-optimize/commit' && method === 'POST') {
      const body = requestBody(init);
      if (body?.id && cloudSessions.has(String(body.id))) {
        return nativeFetch('/api/image-optimize/cloud-commit', init);
      }
    }

    if (url.pathname === '/api/image-optimize/status' && method === 'GET') {
      const id = String(url.searchParams.get('id') || '');
      if (id && cloudSessions.has(id)) {
        return nativeFetch(`/api/image-optimize/cloud-status?id=${encodeURIComponent(id)}`, init);
      }
    }

    return nativeFetch(input, init);
  };
}
