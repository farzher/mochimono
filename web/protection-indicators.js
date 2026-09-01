const files = document.querySelector('#files');

let state = {
  local: new Set(),
  server: new Set(),
  damagedServer: new Set(),
  backed: new Set(),
  verifiedBacked: new Set(),
  safeLocal: new Set(),
  needs: new Set(),
  onlyLocal: new Set(),
  notLocal: new Set()
};

const style = document.createElement('style');
style.textContent = `
  .client-library .protection{display:none}
  .protection-badge{pointer-events:none;white-space:nowrap;font-weight:750;letter-spacing:.01em}
  .file-card{position:relative}
  .file-card .protection-badge{position:absolute;z-index:4;right:6px;bottom:6px;max-width:calc(100% - 12px);overflow:hidden;text-overflow:ellipsis;padding:3px 6px;border-radius:6px;background:rgba(17,15,17,.82);box-shadow:0 1px 5px rgba(0,0,0,.35);backdrop-filter:blur(6px);font-size:8px;color:#cfc6c2}
  .file-card .protection-badge.warn{color:#e2c397;background:rgba(45,34,24,.88)}
  .file-card .protection-badge.danger{color:#efaaa3;background:rgba(54,27,28,.9)}
  .file-row.protection-decorated{grid-template-columns:66px minmax(0,1fr) 120px 84px 116px}
  .file-row .protection-badge{justify-self:end;max-width:116px;overflow:hidden;text-overflow:ellipsis;padding:4px 7px;border-radius:7px;background:rgba(255,255,255,.035);color:#8f8784;font-size:9px;text-align:right}
  .file-row .protection-badge.warn{color:#c9aa7d;background:rgba(154,118,71,.07)}
  .file-row .protection-badge.danger{color:#d99690;background:rgba(155,77,72,.08)}
  @media(max-width:760px){
    .file-row.protection-decorated{grid-template-columns:52px minmax(0,1fr) 72px 92px}
    .file-row.protection-decorated>.refs{display:none}
    .file-row .protection-badge{max-width:92px}
  }
  @media(max-width:520px){
    .file-row.protection-decorated{grid-template-columns:48px minmax(0,1fr) 82px}
    .file-row.protection-decorated>.size{display:none}
    .file-row .protection-badge{max-width:82px;padding:3px 5px;font-size:8px}
  }
`;
document.head.append(style);

function protectionFor(hash) {
  hash = String(hash || '');
  const local = state.local.has(hash);
  const server = state.server.has(hash);
  const backed = state.backed.has(hash);
  const verified = state.verifiedBacked.has(hash);

  if (state.damagedServer.has(hash)) return { className: 'danger', label: 'Mochimono copy damaged', grid: 'Repair needed' };
  if (state.onlyLocal.has(hash)) return { className: 'danger', label: 'Only indexed here', grid: 'Only here' };
  if (local && !server) return { className: 'danger', label: backed ? 'Not in Mochimono' : 'Local only', grid: backed ? 'Not in Mochimono' : 'Local only' };
  if (local && server && !verified) return { className: 'warn', label: backed ? 'Verify backup' : 'Needs backup', grid: backed ? 'Verify backup' : 'Needs backup' };
  if (!local && server && !verified) return { className: 'warn', label: backed ? 'Verify backup' : 'Needs backup', grid: backed ? 'Verify backup' : 'Needs backup' };
  if (state.needs.has(hash)) return { className: 'warn', label: 'Needs protection', grid: 'Needs protection' };
  return null;
}

function decorateItem(item) {
  const hash = item.dataset.hash;
  if (!hash) return;
  item.querySelector(':scope > .protection-badge')?.remove();
  item.classList.remove('protection-decorated');

  if (!Object.hasOwn(item.dataset, 'protectionBaseTitle')) item.dataset.protectionBaseTitle = item.title || '';
  item.title = item.dataset.protectionBaseTitle || '';

  const status = protectionFor(hash);
  if (!status) return;

  const isRow = item.classList.contains('file-row');
  const text = isRow ? status.label : status.grid;
  item.title = [item.dataset.protectionBaseTitle, status.label].filter(Boolean).join(' · ');
  if (!text) return;

  const badge = document.createElement('span');
  badge.className = `protection-badge ${status.className}`.trim();
  badge.textContent = text;
  badge.setAttribute('aria-hidden', 'true');
  item.append(badge);
  if (isRow) item.classList.add('protection-decorated');
}

function decorate() {
  files?.querySelectorAll('[data-hash]').forEach(decorateItem);
}

window.addEventListener('mochimono:locations-updated', event => {
  const next = event.detail || {};
  for (const key of Object.keys(state)) state[key] = next[key] instanceof Set ? next[key] : new Set(next[key] || []);
  decorate();
});

new MutationObserver(mutations => {
  if (!mutations.some(mutation => [...mutation.addedNodes].some(node => node instanceof Element && (node.matches?.('[data-hash]') || node.querySelector?.('[data-hash]'))))) return;
  requestAnimationFrame(decorate);
}).observe(files, { childList: true, subtree: true });
