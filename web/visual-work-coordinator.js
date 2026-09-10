const visual = () => window.mochimonoVisualSort;
const similar = () => window.mochimonoSimilaritySort;
const reasons = new Set();
let aiDepth = 0;

function pause(reason) {
  reason = String(reason || 'external');
  if (reasons.has(reason)) return;
  reasons.add(reason);
  visual()?.pause?.(reason);
  similar()?.pause?.(reason);
}

function resume(reason) {
  reason = String(reason || 'external');
  if (!reasons.delete(reason)) return;
  visual()?.resume?.(reason);
  similar()?.resume?.(reason);
}

window.addEventListener('mochimono:visual-similarity-start', () => pause('find-similar'));
window.addEventListener('mochimono:visual-similarity-end', () => resume('find-similar'));
window.addEventListener('mochimono:ai-work-start', () => {
  aiDepth++;
  if (aiDepth === 1) pause('ai');
});
window.addEventListener('mochimono:ai-work-end', () => {
  if (!aiDepth) return;
  aiDepth--;
  if (!aiDepth) resume('ai');
});

window.mochimonoVisualWorkCoordinator = {
  pause,
  resume,
  reasons:() => [...reasons],
  aiDepth:() => aiDepth
};
