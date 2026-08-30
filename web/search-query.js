const search = document.querySelector('#search');
const value = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');

function normalizeSearchQuery(text) {
  const raw = String(text || '').normalize('NFKC').trim();
  const pathParts = raw.split(/[\\/]+/).filter(Boolean);
  const searchable = pathParts.length > 1 ? pathParts.at(-1) : raw;
  return searchable
    .replace(/[\\/_\-.–—:;,()[\]{}"'`~!@#$%^&*+=|<>?]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

if (search && value?.get && value?.set) {
  // Keep exactly what the user typed visible while app.js reads a forgiving query.
  Object.defineProperty(search, 'value', {
    configurable: true,
    get() {
      return normalizeSearchQuery(value.get.call(this));
    },
    set(next) {
      value.set.call(this, next);
    }
  });
}
