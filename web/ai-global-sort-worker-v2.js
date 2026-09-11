self.postMessage({ type:'progress', done:0, total:1, detail:'Starting AI sort worker…', stage:'startup' });
await import('./ai-global-sort-worker-core-v5.js?v=20260911-3');
