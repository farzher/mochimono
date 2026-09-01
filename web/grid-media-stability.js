const files = document.querySelector('#files');

if (files) {
  function mediaCards(node) {
    if (!(node instanceof Element)) return [];
    const cards = [];
    if (node.matches('.file-card.media-card[data-hash]')) cards.push(node);
    cards.push(...node.querySelectorAll('.file-card.media-card[data-hash]'));
    return cards;
  }

  // app.js keeps the DOM bounded for huge libraries, but extending that window
  // rebuilds the visible markup. Preserve preview image nodes that are present in
  // both the old and new windows so an already-decoded thumbnail never flashes
  // back to the black pending state just because more rows were added.
  new MutationObserver(records => {
    const removed = new Map();

    for (const record of records) {
      for (const node of record.removedNodes) {
        for (const card of mediaCards(node)) {
          const hash = card.dataset.hash;
          const image = card.querySelector('img.cached-thumb');
          if (!hash || !image || removed.has(hash)) continue;
          removed.set(hash, {
            image,
            ratio: card.style.getPropertyValue('--ratio')
          });
        }
      }
    }

    if (!removed.size) return;

    for (const record of records) {
      for (const node of record.addedNodes) {
        for (const card of mediaCards(node)) {
          const kept = removed.get(card.dataset.hash);
          if (!kept) continue;
          const box = card.querySelector('.media-thumb');
          if (!box) continue;

          const placeholder = box.querySelector('img,.video-thumb-pending');
          if (placeholder !== kept.image) {
            placeholder ? placeholder.replaceWith(kept.image) : box.prepend(kept.image);
          }
          if (kept.ratio) card.style.setProperty('--ratio', kept.ratio);
          removed.delete(card.dataset.hash);
        }
      }
    }
  }).observe(files, { childList: true, subtree: true });
}
