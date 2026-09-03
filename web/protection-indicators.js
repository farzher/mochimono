const files = document.querySelector('#files');
let damaged = new Set();
const pending = new Set();
let decorateFrame = 0;
let fullPending = false;

function decorateItem(item) {
  const hash = item.dataset.hash;
  if (!hash) return;
  item.querySelector(':scope > .protection-badge')?.remove();
  item.classList.remove('protection-decorated');
  if (!Object.hasOwn(item.dataset, 'protectionBaseTitle')) item.dataset.protectionBaseTitle = item.title || '';
  item.title = item.dataset.protectionBaseTitle || '';
  if (!damaged.has(hash)) return;
  item.title = [item.title, 'Mochimono copy damaged'].filter(Boolean).join(' · ');
  const badge = document.createElement('span');
  badge.className = 'protection-badge danger';
  badge.textContent = 'Repair needed';
  badge.setAttribute('aria-hidden', 'true');
  item.append(badge);
  if (item.classList.contains('file-row')) item.classList.add('protection-decorated');
}

function decorate() {
  files?.querySelectorAll('[data-hash]').forEach(decorateItem);
}

function collect(node) {
  if (!(node instanceof Element)) return;
  if (node.matches('[data-hash]')) pending.add(node);
  node.querySelectorAll?.('[data-hash]').forEach(item => pending.add(item));
}

function flushPending() {
  decorateFrame = 0;
  if (window.mochimonoGridInteraction?.active?.()) return;
  if (fullPending) {
    fullPending = false;
    pending.clear();
    decorate();
    return;
  }
  for (const item of pending) if (item.isConnected) decorateItem(item);
  pending.clear();
}

function schedulePending() {
  if ((!fullPending && !pending.size) || decorateFrame || window.mochimonoGridInteraction?.active?.()) return;
  decorateFrame = requestAnimationFrame(flushPending);
}

window.addEventListener('mochimono:locations-updated', event => {
  damaged = event.detail?.damagedServer instanceof Set ? event.detail.damagedServer : new Set(event.detail?.damagedServer || []);
  pending.clear();
  fullPending = true;
  schedulePending();
});

new MutationObserver(mutations => {
  if (!damaged.size) return;
  for (const mutation of mutations) for (const node of mutation.addedNodes) collect(node);
  schedulePending();
}).observe(files, { childList: true, subtree: true });

window.addEventListener('mochimono:grid-interaction-end', schedulePending);
