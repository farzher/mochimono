await import('./ai-global-sort-worker-v2.js?v=20260911-4');
const baseSortHandler = self.onmessage;
await import('./ai-global-sort-topics-worker.js?v=20260911-1');
const topicSortHandler = self.onmessage;

self.onmessage = event => {
  const mode = String(event.data?.payload?.mode || '');
  return (mode === 'topics' ? topicSortHandler : baseSortHandler).call(self, event);
};