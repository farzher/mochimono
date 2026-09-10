const visual = () => window.mochimonoVisualSort;
const similar = () => window.mochimonoSimilaritySort;

function pause(reason) {
  visual()?.pause?.(reason);
  similar()?.pause?.(reason);
}

function resume(reason) {
  visual()?.resume?.(reason);
  similar()?.resume?.(reason);
}

window.addEventListener('mochimono:visual-similarity-start', () => pause('find-similar'));
window.addEventListener('mochimono:visual-similarity-end', () => resume('find-similar'));
window.addEventListener('mochimono:ai-work-start', () => pause('ai'));
window.addEventListener('mochimono:ai-work-end', () => resume('ai'));

window.mochimonoVisualWorkCoordinator = { pause, resume };
