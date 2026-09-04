const files = document.querySelector('#files');
const mediaSize = document.querySelector('#mediaSize');

const style = document.createElement('style');
style.textContent = `
.media-thumb{position:relative;isolation:isolate}
.media-thumb>.cached-thumb{position:relative;z-index:1}
.media-thumb>.video-thumb-pending{position:absolute;z-index:2;inset:0;display:block;background:#080809;pointer-events:none}
.media-thumb.thumb-decoding::after{content:"";position:absolute;z-index:3;inset:0;background:#080809;pointer-events:none}
.media-thumb>.play-badge{z-index:4}
#viewer-media>video{width:100vw!important;height:100dvh!important;max-width:100vw!important;max-height:100dvh!important;object-fit:contain!important;background:#000}
`;
document.head.append(style);

function finishDecode(image, box) {
  const reveal = () => requestAnimationFrame(() => requestAnimationFrame(() => {
    if (box.isConnected) box.classList.remove('thumb-decoding');
  }));
  if (!image.decode) return reveal();
  image.decode().then(reveal).catch(reveal);
}

function stabilizeImage(image) {
  if (!(image instanceof HTMLImageElement) || !image.classList.contains('cached-thumb')) return;
  const box = image.closest('.media-thumb');
  if (!box || image.dataset.stabilityWatching === '1') return;
  if (image.complete && image.naturalWidth) return;

  image.dataset.stabilityWatching = '1';
  box.classList.add('thumb-decoding');
  image.addEventListener('load', () => {
    delete image.dataset.stabilityWatching;
    finishDecode(image, box);
  }, { once:true });
  image.addEventListener('error', () => {
    delete image.dataset.stabilityWatching;
    box.classList.remove('thumb-decoding');
  }, { once:true });
}

function imagesIn(node) {
  if (!(node instanceof Element)) return [];
  const result = [];
  if (node.matches('img.cached-thumb')) result.push(node);
  result.push(...node.querySelectorAll('img.cached-thumb'));
  return result;
}

function cardRatio(card) {
  const width = Number(card.dataset.width) || 0;
  const height = Number(card.dataset.height) || 0;
  return width && height ? Math.max(.65, Math.min(2.1, width / height)) : 1;
}

function capJustifiedRows() {
  if (!files?.isConnected) return;
  const target = Number(mediaSize?.value) || 170;
  const cap = target * 1.42;
  for (const row of files.querySelectorAll('.justified-media-row')) {
    const cards = [...row.querySelectorAll(':scope > .file-card.media-card')];
    if (!cards.length) continue;
    const current = Math.max(...cards.map(card => card.getBoundingClientRect().height));
    if (current <= cap + 1) continue;
    const height = cards.length === 1 ? target : cap;
    for (const card of cards) {
      const width = cardRatio(card) * height;
      card.style.width = `${width}px`;
      card.style.height = `${height}px`;
      card.style.flexBasis = `${width}px`;
    }
  }
}

if (files) {
  for (const image of files.querySelectorAll('img.cached-thumb')) stabilizeImage(image);
  new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) for (const image of imagesIn(node)) stabilizeImage(image);
      if (record.target instanceof Element) {
        const box = record.target.closest?.('.media-thumb.thumb-decoding');
        if (box && !box.querySelector('img.cached-thumb')) box.classList.remove('thumb-decoding');
      }
    }
  }).observe(files, { childList:true, subtree:true });
}

window.addEventListener('mochimono:grid-laid-out', capJustifiedRows);
mediaSize?.addEventListener('input', () => requestAnimationFrame(capJustifiedRows));
requestAnimationFrame(capJustifiedRows);
