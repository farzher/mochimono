const CLIENT = document.documentElement.classList.contains('client-library');
const rail = document.querySelector('#dateRail');
const source = document.querySelector('#source');
const search = document.querySelector('#search');
const sort = document.querySelector('#sort');
const type = document.querySelector('#typeFilter');
const collection = document.querySelector('#collectionFilter');
const location = document.querySelector('#locationFilter');
const views = document.querySelector('#views');

const CACHE_KEY = 'mochimono-timeline-rail-v1';
const MAX_AGE = 30 * 24 * 60 * 60 * 1000;

if (CLIENT && rail && source) {
  let cachedHtml = '';
  let holdingCache = false;
  let restoreQueued = false;
  let saveTimer = 0;

  const settled = () => source.options[0]?.textContent?.trim() === 'All sources';
  const defaultView = () =>
    !String(search?.value || '').trim() &&
    !String(source?.value || '') &&
    !String(type?.value || '') &&
    !String(collection?.value || '') &&
    !String(location?.value || '') &&
    String(sort?.value || 'date-desc') === 'date-desc' &&
    !views?.querySelector('[data-view="folders"].active');

  function readCache() {
    try {
      const value = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (!value || Date.now() - Number(value.savedAt || 0) > MAX_AGE) return '';
      return typeof value.html === 'string' ? value.html : '';
    } catch {
      return '';
    }
  }

  function baseRailHtml() {
    const clone = rail.cloneNode(true);
    clone.querySelector(':scope > .rail-semantic')?.remove();
    return clone.innerHTML;
  }

  function neutralRailHtml() {
    if (rail.hidden || !rail.querySelector('.rail-tick')) return '';
    const clone = rail.cloneNode(true);
    clone.querySelector(':scope > .rail-semantic')?.remove();
    for (const tick of clone.querySelectorAll('.rail-tick.active')) tick.classList.remove('active');
    const thumb = clone.querySelector('#railThumb');
    if (thumb) {
      thumb.style.removeProperty('top');
      const label = thumb.querySelector('span');
      if (label) label.textContent = '';
    }
    return clone.innerHTML;
  }

  function saveCanonicalRail() {
    if (!settled() || !defaultView()) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const html = neutralRailHtml();
      if (!html) return;
      cachedHtml = html;
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt: Date.now(), html })); } catch {}
    }, 80);
  }

  function restoreCachedRail() {
    restoreQueued = false;
    if (!holdingCache || settled() || !defaultView() || !cachedHtml) return;
    // rail-polish.js adds a derived visual layer on top of the cached coordinate
    // ticks. Ignore that layer when deciding whether startup code replaced the
    // underlying cached rail, otherwise the two observers would fight each other.
    if (baseRailHtml() !== cachedHtml) rail.innerHTML = cachedHtml;
    if (rail.hidden) rail.hidden = false;
    document.documentElement.classList.add('library-scroll');
  }

  function queueRestore() {
    if (restoreQueued || !holdingCache) return;
    restoreQueued = true;
    queueMicrotask(restoreCachedRail);
  }

  function releaseCachedRail() {
    if (!holdingCache) return;
    holdingCache = false;
    // syncCatalog renders the canonical rail in the same task that populates
    // All sources. Save after paint so the next reload starts with that result.
    requestAnimationFrame(() => requestAnimationFrame(saveCanonicalRail));
  }

  cachedHtml = readCache();
  if (cachedHtml && defaultView() && !settled()) {
    holdingCache = true;
    rail.innerHTML = cachedHtml;
    rail.hidden = false;
    document.documentElement.classList.add('library-scroll');
  }

  const sourceObserver = new MutationObserver(() => {
    if (settled()) releaseCachedRail();
    else queueRestore();
  });
  sourceObserver.observe(source, { childList:true, subtree:true });

  const railObserver = new MutationObserver(() => {
    if (holdingCache) queueRestore();
    else saveCanonicalRail();
  });
  // Only observe replacement of the rail itself. The active tick and thumb move
  // during normal scrolling and should not create cache work.
  railObserver.observe(rail, { childList:true, subtree:false, attributes:true, attributeFilter:['hidden'] });

  const userChangedView = () => {
    if (!defaultView()) holdingCache = false;
    else if (!settled() && cachedHtml) {
      holdingCache = true;
      queueRestore();
    }
  };
  search?.addEventListener('input', userChangedView);
  for (const control of [source, sort, type, collection, location]) control?.addEventListener('change', userChangedView);
  views?.addEventListener('click', () => requestAnimationFrame(userChangedView));

  if (settled()) saveCanonicalRail();
}