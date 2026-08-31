const files = document.querySelector('#files');
const rail = document.querySelector('#dateRail');
const viewer = document.querySelector('#viewer');

let anchor = null;

function hashNodes(nodes) {
  const hashes = [];
  for (const node of nodes) {
    if (node.nodeType !== 1) continue;
    if (node.matches?.('[data-hash]')) hashes.push(node.dataset.hash);
    node.querySelectorAll?.('[data-hash]').forEach(item => hashes.push(item.dataset.hash));
  }
  return hashes;
}

function mode(nodes) {
  for (const node of nodes) {
    if (node.nodeType !== 1) continue;
    const item = node.matches?.('[data-hash]') ? node : node.querySelector?.('[data-hash]');
    if (item?.classList.contains('file-card')) return 'grid';
    if (item?.classList.contains('file-row')) return 'list';
  }
  return '';
}

function sameSequence(a, b) {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}

function collectGridCards(nodes) {
  const result = new Map();
  for (const node of nodes) {
    if (node.nodeType !== 1) continue;
    if (node.matches?.('.file-card[data-hash]')) result.set(node.dataset.hash, node);
    node.querySelectorAll?.('.file-card[data-hash]').forEach(card => result.set(card.dataset.hash, card));
  }
  return result;
}

function syncCard(oldCard, newCard) {
  const transient = [...oldCard.classList].filter(name => name.startsWith('context-'));
  oldCard.className = newCard.className;
  transient.forEach(name => oldCard.classList.add(name));
  oldCard.style.cssText = newCard.style.cssText;
  const filename = newCard.getAttribute('title') || newCard.dataset.filename || '';
  if (filename) oldCard.dataset.filename = filename;
  const oldCopy = oldCard.querySelector('.card-copy');
  const newCopy = newCard.querySelector('.card-copy');
  if (oldCopy && newCopy) oldCopy.innerHTML = newCopy.innerHTML;
}

function captureAnchor() {
  if (!files || !viewer?.hidden) return;
  const commandBottom = document.querySelector('.commandbar')?.getBoundingClientRect().bottom || 0;
  const card = [...files.querySelectorAll('[data-hash]')].find(item => item.getBoundingClientRect().bottom > commandBottom + 1);
  if (!card) {
    anchor = null;
    return;
  }
  anchor = {
    hash: card.dataset.hash,
    top: card.getBoundingClientRect().top,
    scrollY,
    time: performance.now()
  };
}

function restoreAnchor() {
  if (!anchor || performance.now() - anchor.time > 1200) return;
  const card = files.querySelector(`[data-hash="${CSS.escape(anchor.hash)}"]`);
  if (!card) return;
  const delta = card.getBoundingClientRect().top - anchor.top;
  if (Math.abs(delta) > .5) scrollBy(0, delta);
}

for (const event of ['input', 'change']) {
  document.addEventListener(event, e => {
    if (e.target.closest?.('#search,#source,#collectionFilter,#typeFilter,#sort')) captureAnchor();
  }, true);
}
document.querySelector('#views')?.addEventListener('click', captureAnchor, true);

if (files) {
  const observer = new MutationObserver(records => {
    const root = records.find(record => record.target === files && record.removedNodes.length && record.addedNodes.length);
    if (!root) return;

    const removed = [...root.removedNodes];
    const added = [...root.addedNodes];
    const oldHashes = hashNodes(removed);
    const newHashes = hashNodes(added);
    const oldMode = mode(removed);
    const newMode = mode(added);

    observer.disconnect();
    try {
      if (oldMode === newMode && sameSequence(oldHashes, newHashes)) {
        files.replaceChildren(...removed);
      } else if (oldMode === 'grid' && newMode === 'grid') {
        const reusable = collectGridCards(removed);
        for (const card of [...files.querySelectorAll('.file-card[data-hash]')]) {
          const old = reusable.get(card.dataset.hash);
          if (!old) continue;
          const oldMedia = old.classList.contains('media-card');
          const newMedia = card.classList.contains('media-card');
          if (oldMedia !== newMedia) continue;
          syncCard(old, card);
          card.replaceWith(old);
        }
      }
    } finally {
      observer.observe(files, { childList: true, subtree: true });
    }
    requestAnimationFrame(restoreAnchor);
  });
  observer.observe(files, { childList: true, subtree: true });
}

if (rail) {
  const railObserver = new MutationObserver(records => {
    const root = records.find(record => record.target === rail && record.removedNodes.length && record.addedNodes.length);
    if (!root) return;
    const oldIndexes = [...root.removedNodes].flatMap(node => node.nodeType === 1 ? [...node.querySelectorAll?.('[data-index]') || []].map(item => item.dataset.index) : []);
    const newIndexes = [...root.addedNodes].flatMap(node => node.nodeType === 1 ? [...node.querySelectorAll?.('[data-index]') || []].map(item => item.dataset.index) : []);
    if (!sameSequence(oldIndexes, newIndexes)) return;
    railObserver.disconnect();
    rail.replaceChildren(...root.removedNodes);
    railObserver.observe(rail, { childList: true, subtree: true });
  });
  railObserver.observe(rail, { childList: true, subtree: true });
}
