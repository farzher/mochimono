const files = document.querySelector('#files');
const sort = document.querySelector('#sort');

const style = document.createElement('style');
style.textContent = `
  .date-group{margin-top:30px}
  .date-group.year-start{margin-top:42px}
  .date-heading{margin-bottom:10px;font-size:14px;color:#ded5d1;letter-spacing:-.01em}
  .day-break{flex:0 0 100%;width:100%;height:29px;display:flex;align-items:flex-end;padding:0 0 6px 2px;color:#928986;font-size:11px;font-weight:650;pointer-events:none}
  .day-break:not(.first-day){height:43px;padding-top:14px}
  .files.list .day-break{height:27px;padding-bottom:5px}
`;
document.head.append(style);

let frame = 0;

function dateFor(card) {
  const meta = window.mochimonoFileDates?.get(card.dataset.hash);
  const value = sort?.value === 'date-added'
    ? meta?.addedAt
    : meta?.fileDate;
  const date = new Date(value || 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function dayLabel(date) {
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

function decorate() {
  frame = 0;
  if (!files || files.classList.contains('folders')) return;
  const groups = [...files.querySelectorAll('.date-group')];
  let previousYear = null;

  for (const group of groups) {
    group.querySelectorAll('.day-break').forEach(node => node.remove());
    const container = group.querySelector('.date-grid,.date-list');
    if (!container) continue;
    const cards = [...container.children].filter(node => node.matches?.('[data-hash]'));
    let previousDay = '';
    let firstDate = null;
    let dayIndex = 0;

    for (const card of cards) {
      const date = dateFor(card);
      if (!date) continue;
      firstDate ||= date;
      const key = dayKey(date);
      if (key === previousDay) continue;
      const marker = document.createElement('div');
      marker.className = `day-break ${dayIndex++ === 0 ? 'first-day' : ''}`;
      marker.dataset.day = key;
      marker.textContent = dayLabel(date);
      container.insertBefore(marker, card);
      previousDay = key;
    }

    const year = firstDate?.getFullYear() ?? null;
    group.classList.toggle('year-start', year != null && previousYear != null && year !== previousYear);
    if (year != null) previousYear = year;
  }
}

function schedule() {
  if (!frame) frame = requestAnimationFrame(decorate);
}

if (files) new MutationObserver(schedule).observe(files, { childList: true, subtree: true });
sort?.addEventListener('change', () => requestAnimationFrame(schedule));
window.addEventListener('mochimono-dates-updated', schedule);
schedule();
