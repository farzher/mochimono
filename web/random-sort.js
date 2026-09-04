const sortSelect = document.querySelector('#sort');
const root = document.documentElement;
const nativeSort = Array.prototype.sort;
const functionSource = Function.prototype.toString;

let randomMode = false;
let seed = 0;
let libraryWrapped = false;

function newSeed() {
  if (globalThis.crypto?.getRandomValues) {
    const value = new Uint32Array(1);
    crypto.getRandomValues(value);
    return value[0] || 1;
  }
  return ((Math.random() * 0xffffffff) >>> 0) || 1;
}

function randomKey(hash) {
  const text = String(hash || '');
  let value = (2166136261 ^ seed) >>> 0;
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 16777619) >>> 0;
  }
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d) >>> 0;
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b) >>> 0;
  value ^= value >>> 16;
  return value >>> 0;
}

function isLibrarySizeSort(items, compare) {
  if (!randomMode || typeof compare !== 'function' || !items?.length) return false;
  const first = items[0];
  if (!first || typeof first !== 'object' || typeof first.hash !== 'string' || !('size' in first)) return false;
  const source = functionSource.call(compare).replace(/\s+/g, '');
  return source.includes('b.size-a.size') && source.includes('filename.localeCompare');
}

Array.prototype.sort = function(compare) {
  if (isLibrarySizeSort(this, compare)) {
    return nativeSort.call(this, (a, b) => randomKey(a.hash) - randomKey(b.hash) || String(a.hash).localeCompare(String(b.hash)));
  }
  return nativeSort.call(this, compare);
};

function setMode(enabled, reshuffle = false) {
  randomMode = Boolean(enabled);
  if (randomMode && reshuffle) seed = newSeed();
  root.classList.toggle('random-sort-active', randomMode);
}

function installOption() {
  if (!sortSelect || sortSelect.querySelector('option[value="random"]')) return;
  const option = document.createElement('option');
  option.value = 'random';
  option.textContent = 'Random';
  sortSelect.append(option);
}

function wrapLibrary() {
  const library = window.mochimonoLibrary;
  if (!library || libraryWrapped) {
    if (!libraryWrapped) requestAnimationFrame(wrapLibrary);
    return;
  }
  libraryWrapped = true;

  const originalSetSort = library.setSort.bind(library);
  const originalState = library.state.bind(library);

  library.setSort = value => {
    if (String(value) === 'random') {
      setMode(true, true);
      sortSelect.value = 'size-desc';
      originalSetSort('size-desc');
      sortSelect.value = 'random';
      return;
    }
    setMode(false);
    originalSetSort(value);
  };

  library.state = () => {
    const state = originalState();
    return randomMode ? { ...state, sort: 'random' } : state;
  };
}

if (sortSelect) {
  installOption();
  sortSelect.addEventListener('change', () => {
    if (sortSelect.value === 'random') {
      setMode(true, true);
      // Reuse the library's stable non-date virtualized path. Its exact size
      // comparator is swapped for a stable random rank only while Random is on.
      sortSelect.value = 'size-desc';
      queueMicrotask(() => {
        if (randomMode) sortSelect.value = 'random';
      });
      return;
    }
    setMode(false);
  }, true);
}

const style = document.createElement('style');
style.textContent = 'html.random-sort-active #dateRail{display:none!important}html.random-sort-active{scrollbar-width:auto!important}html.random-sort-active::-webkit-scrollbar{display:block!important}';
document.head.append(style);

wrapLibrary();
