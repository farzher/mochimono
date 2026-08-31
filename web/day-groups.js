const files = document.querySelector('#files');
const sort = document.querySelector('#sort');

const style = document.createElement('style');
style.textContent = `
  .date-group{margin-top:30px}
  .date-heading{margin:0 0 10px 2px;font-size:14px;color:#ded5d1;letter-spacing:-.01em}
  .day-break{flex:0 0 100%;width:100%;height:28px;display:flex;align-items:flex-end;padding:0 0 6px 2px;color:#928986;font-size:11px;font-weight:650;pointer-events:none}
  .day-break:not(.first-day){height:36px;padding-top:8px}
  .files.list .day-break{height:27px;padding-bottom:5px}
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

function dayLabel(date) {
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

function decorateGroup(group) {
  const container = group.querySelector(':scope > .date-grid,:scope > .date-list');
  if (!container) return;
  const cards = [...container.children].filter(node => node.matches?.('[data-hash]'));
  const entries = cards.map(card => {
    const date = dateFor(card);
    return { card, date, key: date ? dayKey(date) : '' };
  });
  const signature = `${sort?.value || ''}|${entries.map(item => `${item.card.dataset.hash}:${item.key}`).join('|')}`;
  if (group.dataset.daySignature === signature) return;
  group.dataset.daySignature = signature;

  container.querySelectorAll(':scope > .day-break').forEach(node => node.remove());
  let previousDay = '';
  let dayIndex = 0;
  for (const item of entries) {
    if (!item.date || !item.key || item.key === previousDay) continue;
    const marker = document.createElement('div');
    marker.className = `day-break ${dayIndex++ === 0 ? 'first-day' : ''}`;
    marker.dataset.day = item.key;
    marker.textContent = dayLabel(item.date);
    container.insertBefore(marker, item.card);
    previousDay = item.key;
  }
}

function decorate() {
  frame = 0;
  if (!files || files.classList.contains('folders')) return;
  for (const group of files.querySelectorAll('.date-group')) decorateGroup(group);
}

function schedule() {
  if (!frame) frame = requestAnimationFrame(decorate);
}

if (files) new MutationObserver(schedule).observe(files, { childList: true, subtree: true });
sort?.addEventListener('change', () => {
  for (const group of files?.querySelectorAll('.date-group') || []) delete group.dataset.daySignature;
  schedule();
});
window.addEventListener('mochimono-dates-updated', () => {
  for (const group of files?.querySelectorAll('.date-group') || []) delete group.dataset.daySignature;
  schedule();
});
schedule();
