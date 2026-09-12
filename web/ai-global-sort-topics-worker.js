self.postMessage({ type:'progress', done:0, total:1, detail:'Starting neighborhood AI sorter…', stage:'startup' });

const run = new URL(self.location.href).searchParams.get('run') || new URL(self.location.href).searchParams.get('v') || Date.now().toString(36);
const url = new URL('./ai-global-sort-worker-v6.js', import.meta.url);
url.searchParams.set('run', run);
await import(url.href);
