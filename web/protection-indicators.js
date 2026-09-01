const files = document.querySelector('#files');
let damaged = new Set();

const style = document.createElement('style');
style.textContent = `
  .file-card{position:relative}
  .protection-badge{pointer-events:none;white-space:nowrap;font-weight:750;letter-spacing:.01em}
  .file-card .protection-badge{position:absolute;z-index:4;right:6px;bottom:6px;padding:3px 6px;border-radius:6px;background:rgba(54,27,28,.9);box-shadow:0 1px 5px rgba(0,0,0,.35);backdrop-filter:blur(6px);font-size:8px;color:#efaaa3}
  .file-row.protection-decorated{grid-template-columns:66px minmax(0,1fr) 120px 84px 116px}
  .file-row .protection-badge{justify-self:end;max-width:116px;overflow:hidden;text-overflow:ellipsis;padding:4px 7px;border-radius:7px;background:rgba(155,77,72,.08);color:#d99690;font-size:9px;text-align:right}
`;
document.head.append(style);

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

window.addEventListener('mochimono:locations-updated', event => {
  damaged = event.detail?.damagedServer instanceof Set ? event.detail.damagedServer : new Set(event.detail?.damagedServer || []);
  decorate();
});

new MutationObserver(mutations => {
  if (!mutations.some(mutation => [...mutation.addedNodes].some(node => node instanceof Element && (node.matches?.('[data-hash]') || node.querySelector?.('[data-hash]'))))) return;
  requestAnimationFrame(decorate);
}).observe(files, { childList: true, subtree: true });
