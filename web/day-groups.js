const files = document.querySelector('#files');
const sort = document.querySelector('#sort');
const mediaSize = document.querySelector('#mediaSize');

const style = document.createElement('style');
style.textContent = `
  .date-group{margin-top:30px}
  .date-heading{margin:0 0 10px 2px;font-size:14px;color:#ded5d1;letter-spacing:-.01em}
  .files.grid .date-grid>.day-row-start{margin-top:22px}
  .files.grid .date-grid>.day-start{position:relative}
  .files.grid .date-grid>.day-start::before{content:attr(data-day-label);position:absolute;left:2px;top:-18px;z-index:2;color:#928986;font-size:11px;font-weight:650;line-height:14px;white-space:nowrap;pointer-events:none}
`;
document.head.append(style);

let frame = 0;
let layoutVersion = 0;

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

function sameRow(a, b) {
  return Math.abs(a.offsetTop - b.offsetTop) <= 1;
}

function decorateGroup(group) {
  const container = group.querySelector(':scope > .date-grid,:scope > .date-list');
  if (!container) return;
  const cards = [...container.children].filter(node => node.matches?.('[data-hash]'));
  const entries = cards.map(card => {
    const date = dateFor(card);
    return { card, date, key: date ? dayKey(date) : '' };
  });
  const signature = `${layoutVersion}|${container.clientWidth}|${sort?.value || ''}|${entries.map(item => `${item.card.dataset.hash}:${item.key}`).join('|')}`;
  if (group.dataset.daySignature === signature) return;

  for (const card of cards) {
    card.classList.remove('day-start', 'day-row-start');
    delete card.dataset.day;
    delete card.dataset.dayLabel;
  }

  // Read row positions only after clearing the previous decoration so the
  // spacing itself never influences which cards belong to a row.
  const rowStarts = [];
  let previousDay = '';
  for (const item of entries) {
    if (!item.key) continue;
    if (item.key !== previousDay) {
      item.card.classList.add('day-start');
      item.card.dataset.dayLabel = dayLabel(item.date);
      rowStarts.push(item.card);
    }
    item.card.dataset.day = item.key;
    previousDay = item.key;
  }

  if (container.classList.contains('date-grid')) {
    for (const start of rowStarts) {
      for (const card of cards) {
        if (sameRow(card, start)) card.classList.add('day-row-start');
      }
    }
  }

  group.dataset.daySignature = signature;
}

function decorate() {
  frame = 0;
  if (!files || files.classList.contains('folders')) return;
  for (const group of files.querySelectorAll('.date-group')) decorateGroup(group);
}

function invalidate(layout = false) {
  if (layout) layoutVersion++;
  for (const group of files?.querySelectorAll('.date-group') || []) delete group.dataset.daySignature;
  schedule();
}

function schedule() {
  if (!frame) frame = requestAnimationFrame(decorate);
}

if (files) new MutationObserver(schedule).observe(files, { childList: true, subtree: true });
sort?.addEventListener('change', () => invalidate());
mediaSize?.addEventListener('input', () => invalidate(true));
window.addEventListener('resize', () => invalidate(true), { passive: true });
window.addEventListener('mochimono-dates-updated', () => invalidate());
schedule();
