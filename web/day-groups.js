const files = document.querySelector('#files');
const sort = document.querySelector('#sort');

const style = document.createElement('style');
style.textContent = `
  .date-group{margin-top:30px}
  .date-heading{margin:0 0 10px 2px;font-size:14px;color:#ded5d1;letter-spacing:-.01em}
  .files.grid .date-grid>.day-start:not(:first-child){margin-left:9px}
`;
document.head.append(style);

let frame = 0;

function dateFor(card) {
  const meta = window.mochimonoFileDates?.get(card.dataset.hash);
  const value = sort?.value === 'date-added' ? meta?.addedAt : meta?.fileDate;
  const date = new Date(value || 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function decorateGroup(group) {
  const container = group.querySelector(':scope > .date-grid,:scope > .date-list');
  if (!container) return;
  const cards = [...container.children].filter(node => node.matches?.('[data-hash]'));
  const entries = cards.map(card => {
    const date = dateFor(card);
    return { card, key: date ? dayKey(date) : '' };
  });
  const signature = `${sort?.value || ''}|${entries.map(item => `${item.card.dataset.hash}:${item.key}`).join('|')}`;
  if (group.dataset.daySignature === signature) return;
  group.dataset.daySignature = signature;

  for (const card of cards) {
    card.classList.remove('day-start');
    delete card.dataset.day;
  }

  let previousDay = '';
  let first = true;
  for (const item of entries) {
    if (!item.key) continue;
    if (!first && item.key !== previousDay) item.card.classList.add('day-start');
    item.card.dataset.day = item.key;
    previousDay = item.key;
    first = false;
  }
}

function decorate() {
  frame = 0;
  if (!files || files.classList.contains('folders')) return;
  for (const group of files.querySelectorAll('.date-group')) decorateGroup(group);
}

function invalidate() {
  for (const group of files?.querySelectorAll('.date-group') || []) delete group.dataset.daySignature;
  schedule();
}

function schedule() {
  if (!frame) frame = requestAnimationFrame(decorate);
}

if (files) new MutationObserver(schedule).observe(files, { childList: true, subtree: true });
sort?.addEventListener('change', invalidate);
window.addEventListener('mochimono-dates-updated', invalidate);
schedule();
