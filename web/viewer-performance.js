const viewer = document.querySelector('#viewer');
const viewerMedia = document.querySelector('#viewer-media');
const viewerOpen = document.querySelector('#viewer-open');
const files = document.querySelector('#files');

const objectHash = value => String(value || '').match(/\/api\/objects\/([a-f0-9]{64})/)?.[1] || '';
const currentHash = () => objectHash(viewerOpen?.getAttribute('href'));
const hasLocalCopy = hash => Boolean(hash && (
  window.mochimonoFastLocalHashes?.has?.(hash) ||
  window.mochimonoLocations?.forHash?.(hash)?.length
));

// app.js already does the right thing for the current image: keep the small
// thumbnail visible, load/decode the full object offscreen, then swap it in.
// Earlier local-first code bypassed that handoff and also blocked both neighbor
// preloads. Keep the current loader intact and only serialize LOCAL neighbor
// warming so huge photos do not all decode at once.
const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
const approved = new WeakSet();
const pending = [];
const kept = [];
const hoverWarm = new Map();
let warming = null;
let queuedFor = '';
let hoverTimer = 0;

function keep(image) {
  kept.push(image);
  while (kept.length > 3) kept.shift();
}

function clearPendingFor(current) {
  if (queuedFor === current) return;
  queuedFor = current;
  pending.length = 0;
}

function queueNeighbor(value) {
  const hash = objectHash(value);
  if (!hash || !viewer || viewer.hidden || !hasLocalCopy(hash)) return false;
  const current = currentHash();
  if (!current || hash === current) return false;
  clearPendingFor(current);
  if (!pending.some(item => item.hash === hash)) pending.push({ hash, url: String(value) });
  return true;
}

function warmNext() {
  if (warming || !viewer || viewer.hidden) return;
  const current = currentHash();
  clearPendingFor(current);
  let task;
  while ((task = pending.shift())) {
    if (task.hash && task.hash !== current) break;
    task = null;
  }
  if (!task) return;

  const image = new Image();
  approved.add(image);
  warming = image;
  image.decoding = 'async';
  const done = async () => {
    if (warming !== image) return;
    try { await image.decode(); } catch {}
    keep(image);
    warming = null;
    warmNext();
  };
  image.onload = done;
  image.onerror = () => {
    if (warming === image) warming = null;
    warmNext();
  };
  image.src = task.url;
}

function warmGridCard(card) {
  if (!card?.matches?.('.file-card.media-card[data-hash]') || card.classList.contains('video-card')) return;
  const hash = String(card.dataset.hash || '');
  if (!hash || !hasLocalCopy(hash) || hoverWarm.has(hash)) return;
  const image = new Image();
  approved.add(image);
  image.decoding = 'async';
  hoverWarm.set(hash, image);
  while (hoverWarm.size > 2) hoverWarm.delete(hoverWarm.keys().next().value);
  image.onload = async () => {
    try { await image.decode(); } catch {}
    keep(image);
  };
  image.onerror = () => hoverWarm.delete(hash);
  image.src = `/api/objects/${hash}`;
}

if (descriptor?.get && descriptor?.set) {
  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    configurable: true,
    enumerable: descriptor.enumerable,
    get: descriptor.get,
    set(value) {
      if (!approved.has(this) && !this.isConnected && queueNeighbor(value)) return;
      descriptor.set.call(this, value);
    }
  });
}

if (viewerMedia) {
  viewerMedia.addEventListener('load', event => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement) || !image.isConnected) return;
    const hash = objectHash(image.currentSrc || image.src);
    if (!hash || hash !== currentHash()) return;
    // The visible current full-resolution image has completed its swap. Now the
    // queued next/previous originals can use spare time without competing with it.
    warmNext();
  }, true);
}

if (files) {
  files.addEventListener('pointerover', event => {
    const card = event.target.closest?.('.file-card.media-card[data-hash]');
    if (!card) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => warmGridCard(card), 90);
  }, { passive:true });
  files.addEventListener('pointerout', () => clearTimeout(hoverTimer), { passive:true });
  files.addEventListener('pointerdown', event => {
    clearTimeout(hoverTimer);
    warmGridCard(event.target.closest?.('.file-card.media-card[data-hash]'));
  }, { passive:true });
  files.addEventListener('focusin', event => warmGridCard(event.target.closest?.('.file-card.media-card[data-hash]')));
}

window.addEventListener('mochimono:locations-updated', warmNext);
