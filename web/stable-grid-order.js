const files = document.querySelector('#files');

function placeRow(row) {
  const plane = row?.parentElement;
  if (!plane?.classList.contains('stable-media-plane')) return;
  const id = Number(row.dataset.stableRow);
  if (!Number.isInteger(id)) return;

  for (const sibling of plane.children) {
    if (sibling === row || !sibling.classList?.contains('stable-grid-row')) continue;
    const siblingId = Number(sibling.dataset.stableRow);
    if (Number.isInteger(siblingId) && siblingId > id) {
      if (row.nextSibling !== sibling) plane.insertBefore(row, sibling);
      return;
    }
  }
}

if (files) {
  new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.classList.contains('stable-grid-row')) placeRow(node);
        for (const row of node.querySelectorAll?.('.stable-grid-row') || []) placeRow(row);
      }
    }
  }).observe(files, { childList: true, subtree: true });
}
