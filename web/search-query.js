const search = document.querySelector('#search');
const value = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');

function normalizeSearchQuery(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/[\\/_\-.–—:;,()[\]{}"'`~!@#$%^&*+=|<>?]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

if (search && value?.get && value?.set) {
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
