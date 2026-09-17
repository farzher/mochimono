const nativeFetch = window.fetch.bind(window);
const ttlByPath = new Map([
  ['/api/state', 300],
  ['/api/folder-stats', 600],
  ['/api/backups', 800]
]);
const cache = new Map();
const inflight = new Map();

function requestInfo(input, options = {}) {
  let url;
  try { url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href); }
  catch { return null; }
  const method = String(options.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const ttl = url.origin === location.origin ? ttlByPath.get(url.pathname) : 0;
  if (!ttl || method !== 'GET' || options.signal) return null;
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(options.headers || {}).forEach((value, key) => headers.set(key, value));
  if (headers.has('range')) return null;
  return { key:url.href, ttl };
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
  const info = requestInfo(input, options);
  if (!info) return nativeFetch(input, options);

  const now = performance.now();
  const cached = cache.get(info.key);
  if (cached && cached.expires > now) return responseFrom(cached.snapshot);

  let pending = inflight.get(info.key);
  if (!pending) {
    pending = nativeFetch(input, options).then(async response => {
      const value = await snapshot(response);
      if (response.ok) cache.set(info.key, { snapshot:value, expires:performance.now() + info.ttl });
      return value;
    }).finally(() => inflight.delete(info.key));
    inflight.set(info.key, pending);
  }
  return responseFrom(await pending);
};

window.mochimonoInvalidateShellFetch = pathname => {
  if (!pathname) { cache.clear(); return; }
  for (const key of cache.keys()) {
    try { if (new URL(key).pathname === pathname) cache.delete(key); } catch {}
  }
};
