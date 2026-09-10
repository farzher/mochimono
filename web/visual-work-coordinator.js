const visual = () => window.mochimonoVisualSort;
const similar = () => window.mochimonoSimilaritySort;
const sort = document.querySelector('#sort');
const reasons = new Set();
let suspendedVisualSort = false;

function visualBusy() {
  return document.documentElement.classList.contains('visual-sort-indexing') || Boolean(visual()?.cache?.().runningKey);
}

function pause(reason) {
  reason = String(reason || 'external');
  reasons.add(reason);

  const visualApi = visual();
  if (typeof visualApi?.pause === 'function') visualApi.pause(reason);
  else if (!suspendedVisualSort && sort?.value === 'visual' && visualBusy()) {
    suspendedVisualSort = true;
    sort.value = 'date-desc';
    sort.dispatchEvent(new Event('change', { bubbles:true }));
  }

  similar()?.pause?.(reason);
}

function resume(reason) {
  reason = String(reason || 'external');
  reasons.delete(reason);
  visual()?.resume?.(reason);
  similar()?.resume?.(reason);

  if (!reasons.size && suspendedVisualSort && sort) {
    suspendedVisualSort = false;
    sort.value = 'visual';
    sort.dispatchEvent(new Event('change', { bubbles:true }));
  }
}

window.addEventListener('mochimono:visual-similarity-start', () => pause('find-similar'));
window.addEventListener('mochimono:visual-similarity-end', () => resume('find-similar'));
window.addEventListener('mochimono:ai-work-start', () => pause('ai'));
window.addEventListener('mochimono:ai-work-end', () => resume('ai'));

window.mochimonoVisualWorkCoordinator = {
  pause,
  resume,
  reasons:() => [...reasons],
  suspended:() => suspendedVisualSort
};
