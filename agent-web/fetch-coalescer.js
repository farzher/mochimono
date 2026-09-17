const nativeFetch = window.fetch.bind(window);
const COALESCED_PATHS = new Set(['/api/state', '/api/folder-stats', '/api/backups']);
const inflight = new Map();

function requestKey(input, options = {}) {
  let url;
  try { url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href); }
  catch { return '' ; }
  const method = String(options.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (url.origin !== location.origin || method !== 'GET' || options.signal || !COALESCED_PATHS.has(url.pathname)) return '';
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(options.headers || {}).forEach((value, key) => headers.set(key, value));
  if (headers.has('range')) return '';
  return url.href;
}

function responseFrom(snapshot) {
  return new Response(snapshot.body.slice(0), {
    status:snapshot.status,
    statusText:snapshot.statusText,
    headers:snapshot.headers
  });
}

async function snapshot(response) {
  return {
    status:response.status,
    statusText:response.statusText,
    headers:[...response.headers.entries()],
    body:await response.clone().arrayBuffer()
  };
}

window.fetch = async function coalescedFetch(input, options = {}) {
  const key = requestKey(input, options);
  if (!key) return nativeFetch(input, options);

  let pending = inflight.get(key);
  if (!pending) {
    pending = nativeFetch(input, options)
      .then(snapshot)
      .finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return responseFrom(await pending);
};
