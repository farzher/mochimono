const sort = document.querySelector('#sort');

const style = document.createElement('style');
style.textContent = 'html.similarity-sort-indexing #dateRail,html.visual-sort-indexing #dateRail{display:none!important}';
document.head.append(style);

let restoreSort = '';
try {
  const saved = JSON.parse(localStorage.getItem('mochimono-library-ui') || '{}')?.sort;
  if (saved === 'similar' || saved === 'visual') restoreSort = saved;
} catch {}

if (restoreSort && sort?.querySelector(`option[value="${restoreSort}"]`)) {
  sort.value = restoreSort;
  sort.dispatchEvent(new Event('change', { bubbles:true }));
}
