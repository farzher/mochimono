const files = document.querySelector('#files');
const search = document.querySelector('#search');

const style = document.createElement('style');
style.textContent = `
  .file-context-name mark{padding:0;background:transparent;color:#ff6f67;font-weight:800}
  .files.grid>.empty{width:100vw;min-height:40vh;margin-left:calc(50% - 50vw);padding:0;display:grid;place-items:center;text-align:center}
  @media(min-width:701px){
    #source{width:136px}
    #collectionFilter{width:136px}
    #typeFilter{width:104px}
    #sort{width:92px}
  }
`;
document.head.append(style);

let frame = 0;

function queryTerms(raw) {
  const field = String(raw || '').match(/\b(name|path|source|type|ext|year):/i)?.[1]?.toLowerCase() || '';
  if (field && field !== 'name') return [];
  const text = String(raw || '')
    .replace(/\bname:/gi, ' ')
    .replace(/["']/g, ' ')
    .trim();
  return [...new Set(text.split(/\s+/).map(term => term.trim()).filter(Boolean))];
}

function highlight(element, filename, raw) {
  const terms = queryTerms(raw).filter(term => filename.toLowerCase().includes(term.toLowerCase()));
  const key = `${filename}\u0000${raw}\u0000${terms.join('\u0001')}`;
  if (element.dataset.filenameHighlightKey === key) return;
  element.dataset.filenameHighlightKey = key;
  element.replaceChildren();
  if (!terms.length) {
    element.textContent = filename;
    return;
  }
  const escaped = terms
    .sort((a, b) => b.length - a.length)
    .map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const regex = new RegExp(`(${escaped.join('|')})`, 'ig');
  let offset = 0;
  for (const match of filename.matchAll(regex)) {
    if (match.index > offset) element.append(document.createTextNode(filename.slice(offset, match.index)));
    const mark = document.createElement('mark');
    mark.textContent = match[0];
    element.append(mark);
    offset = match.index + match[0].length;
  }
  if (offset < filename.length) element.append(document.createTextNode(filename.slice(offset)));
}

function decorate() {
  frame = 0;
  const raw = search?.value?.trim() || '';
  for (const card of files?.querySelectorAll('.file-card[data-hash]') || []) {
    const name = card.querySelector('.file-context-name');
    if (!name) continue;
    const filename = card.dataset.filename || name.textContent || 'File';
    highlight(name, filename, raw);
  }
}

function schedule() {
  if (!frame) frame = requestAnimationFrame(decorate);
}

search?.addEventListener('input', schedule);
if (files) new MutationObserver(schedule).observe(files, { childList: true, subtree: true });
schedule();