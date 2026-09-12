const run = new URL(self.location.href).searchParams.get('run') || Date.now().toString(36);
const url = new URL('./ai-global-sort-worker-v6.js', import.meta.url);
url.searchParams.set('run', run);

try {
  await import(url.href);
  self.postMessage({ type:'progress', done:0, total:1, detail:'Neighborhood AI sorter ready…', stage:'startup' });
} catch (error) {
  self.postMessage({
    type:'error',
    error:`Could not load neighborhood AI sorter: ${error?.message || error}`
  });
}
