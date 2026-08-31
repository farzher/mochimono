const files = document.querySelector('#files');
const sort = document.querySelector('#sort');
const mediaSize = document.querySelector('#mediaSize');

const style = document.createElement('style');
style.textContent = `
  .date-group{margin-top:26px}
  .date-group.timeline-continuation{margin-top:4px}
  .year-heading{margin:42px 0 15px 2px;color:#f1e9e5;font-size:19px;font-weight:760;letter-spacing:-.025em}
  .date-group:first-child>.year-heading{margin-top:20px}
  .date-heading{margin:0 0 10px 2px;font-size:13px;color:#cfc5c1;letter-spacing:-.01em}
  .files.grid .date-grid>.day-row-start{margin-top:22px}
  .files.grid .date-grid>.day-start{position:relative;overflow:visible}
  .files.grid .date-grid>.day-start>.thumb{overflow:hidden;border-radius:3px}
  .files.grid .date-grid>.day-start::before{content:attr(data-day-label);position:absolute;left:2px;top:-18px;z-index:4;color:#958c89;font-size:11px;font-weight:650;line-height:14px;white-space:nowrap;pointer-events:none}
`;
document.head.append(style);

let frame = 0;
let layoutVersion = 0;

function dateFor(card) {
  const meta = window.mochimonoFileDates?.get(card.dataset.hash);
  const value = sort?.value === 'date-added'
    ? (card.dataset.addedAt || meta?.addedAt)
    : (card.dataset.fileDate || meta?.fileDate);
  const date = new Date(value || 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function dayLabel(date) {
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function monthName(date) {
  return date?.toLocaleDateString(undefined, { month: 'long' }) || '';
}

function groupDate(group) {
  const card = group.querySelector(':scope > .date-grid > [data-hash],:scope > .date-list > [data-hash]');
  return card ? dateFor(card) : null;
}

function decorateYears(groups) {
  let previousYear = null;
  let previousMonth = '';
  for (const group of groups) {
    const date = groupDate(group);
    const year = date?.getFullYear() ?? null;
    const month = date ? monthKey(date) : '';
    const monthHeading = group.querySelector(':scope > .date-heading');
    if (monthHeading) {
      monthHeading.textContent = monthName(date);
      monthHeading.hidden = Boolean(month && month === previousMonth);
    }

    let heading = group.querySelector(':scope > .year-heading');
    const needsYear = year != null && year !== previousYear;
    if (needsYear) {
      if (!heading) {
        heading = document.createElement('h2');
        heading.className = 'year-heading';
        group.prepend(heading);
      }
      heading.textContent = String(year);
    } else {
      heading?.remove();
    }
    group.classList.toggle('timeline-continuation', Boolean(month && month === previousMonth));
    if (year != null) previousYear = year;
    if (month) previousMonth = month;
  }
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

  const rowTop = new Map(cards.map(card => [card, card.offsetTop]));
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
      const top = rowTop.get(start);
      for (const card of cards) {
        if (Math.abs((rowTop.get(card) ?? 0) - top) <= 1) card.classList.add('day-row-start');
      }
    }
  }

  group.dataset.daySignature = signature;
}

function decorate() {
  frame = 0;
  if (!files || files.classList.contains('folders')) return;
  const groups = [...files.querySelectorAll('.date-group')];
  decorateYears(groups);
  for (const group of groups) decorateGroup(group);
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
