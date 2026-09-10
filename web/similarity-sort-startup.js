const sort = document.querySelector('#sort');

const style = document.createElement('style');
style.textContent = 'html.similarity-sort-indexing #dateRail{display:none!important}';
document.head.append(style);

let restoreSimilar = false;
try {
  restoreSimilar = JSON.parse(localStorage.getItem('mochimono-library-ui') || '{}')?.sort === 'similar';
} catch {}

if (restoreSimilar && sort?.querySelector('option[value="similar"]')) {
  sort.value = 'similar';
  sort.dispatchEvent(new Event('change', { bubbles:true }));
}
