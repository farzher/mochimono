const files = document.querySelector('#files');
const THUMB_VERSION = 3;
const states = new Map();
const observed = new Set();
const nearby = new Set();
let checkTimer = 0;
let checking = false;
let missRounds = 0;

const IMAGE_EXTENSIONS = new Set(['jpg','jpeg','png','gif','webp','heic','heif','avif','bmp','tif','tiff']);
const VIDEO_EXTENSIONS = new Set(['mp4','m4v','mov','mkv','webm','avi','mpg','mpeg','m2v','mts','m2ts','3gp']);
const extension = name => String(name || '').toLowerCase().match(/\.([^.]+)$/)?.[1] || '';
const filename = card => card.dataset.filename || card.title || card.querySelector('strong')?.textContent || '';
const kind = card => {
  if (card.classList.contains('video-card')) return 'video';
  if (card.classList.contains('media-card')) return 'image';
  const ext = extension(filename(card));
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  return '';
};
const thumbUrl = hash => `/api/thumbs/${hash}?v=${THUMB_VERSION}`;

function cardsFor(hash) {
  return files.querySelectorAll(`[data-hash="${CSS.escape(hash)}"]`);
}

function mediaBox(card, mediaKind = kind(card)) {
  let box = card.querySelector('.media-thumb');
  if (box) return box;
  if (!card.classList.contains('file-row') && !card.classList.contains('file-folder-row')) return null;

  box = document.createElement('span');
  box.className = `tiny-preview media-thumb ${mediaKind === 'video' ? 'video' : ''}`;
  const old = card.classList.contains('file-row') ? card.querySelector('.type') : card.querySelector('.document-icon');
  old?.replaceWith(box);
  return box;
}

function ensurePending(card, mediaKind = kind(card)) {
  const box = mediaBox(card, mediaKind);
  if (!box || box.querySelector('.cached-thumb,.video-thumb-pending')) return;
  const pending = document.createElement('span');
  pending.className = 'video-thumb-pending';
  pending.dataset.videoThumb = card.dataset.hash || '';
  box.prepend(pending);
}

function applyDimensions(hash, width, height) {
  if (!width || !height) return;
  const ratio = Math.max(.65, Math.min(2.1, width / height));
  for (const card of cardsFor(hash)) if (card.classList.contains('media-card')) card.style.setProperty('--ratio', ratio);
}

function applyReady(hash, width = 0, height = 0) {
  const state = states.get(hash) || {};
  state.ready = true;
  state.width = width || state.width || 0;
  state.height = height || state.height || 0;
  states.set(hash, state);
  applyDimensions(hash, state.width, state.height);

  for (const card of cardsFor(hash)) {
    const mediaKind = kind(card);
    if (!mediaKind) continue;
    const box = mediaBox(card, mediaKind);
    if (!box || box.querySelector('img.cached-thumb')) continue;
    const image = document.createElement('img');
    image.className = 'cached-thumb server-thumb';
    image.decoding = 'async';
    image.loading = 'lazy';
    image.alt = filename(card);
    image.onload = () => {
      if (image.naturalWidth && image.naturalHeight) applyDimensions(hash, image.naturalWidth, image.naturalHeight);
    };
    image.onerror = () => {
      image.remove();
      const current = states.get(hash) || {};
      current.ready = false;
      states.set(hash, current);
      missRounds = 0;
      scheduleCheck(250);
    };
    const old = box.querySelector('img,.video-thumb-pending');
    old ? old.replaceWith(image) : box.prepend(image);
    image.src = thumbUrl(hash);
  }
}

function nearbyCards() {
  return [...nearby].filter(card => card.isConnected && kind(card));
}

async function checkNearby() {
  checkTimer = 0;
  if (checking || document.hidden || !files) return;
  const cards = nearbyCards();
  if (!cards.length) return;

  const hashes = [];
  for (const card of cards) {
    const hash = card.dataset.hash;
    const mediaKind = kind(card);
    ensurePending(card, mediaKind);
    const state = states.get(hash) || {};
    if (state.ready) {
      applyReady(hash, state.width, state.height);
      continue;
    }
    if (hash && !hashes.includes(hash)) hashes.push(hash);
  }
  if (!hashes.length) return;

  checking = true;
  let becameReady = 0;
  try {
    const response = await fetch('/api/thumbs/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hashes: hashes.slice(0, 500) })
    });
    if (!response.ok) return;
    const data = await response.json();
    const ready = new Map((data.thumbnails || []).map(item => [item.hash, item]));
    for (const hash of hashes) {
      const thumbnail = ready.get(hash);
      if (thumbnail) {
        if (!states.get(hash)?.ready) becameReady++;
        applyReady(hash, Number(thumbnail.width), Number(thumbnail.height));
      } else {
        const state = states.get(hash) || {};
        state.ready = false;
        states.set(hash, state);
      }
    }
  } catch {}
  finally {
    checking = false;
    if (becameReady) missRounds = 0;
    else missRounds = Math.min(5, missRounds + 1);
    if (nearbyCards().some(card => !states.get(card.dataset.hash)?.ready)) {
      scheduleCheck(Math.min(5000, 500 * 2 ** Math.max(0, missRounds - 1)));
    }
  }
}

function scheduleCheck(delay = 30) {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(checkNearby, delay);
}

const observer = files ? new IntersectionObserver(entries => {
  let entered = false;
  for (const entry of entries) {
    if (entry.isIntersecting) {
      nearby.add(entry.target);
      entered = true;
    } else nearby.delete(entry.target);
  }
  if (entered) {
    missRounds = 0;
    scheduleCheck();
  }
}, { rootMargin: '800px 0px' }) : null;

function cardsIn(node) {
  if (!(node instanceof Element)) return [];
  const cards = [];
  if (node.matches('[data-hash]')) cards.push(node);
  cards.push(...node.querySelectorAll('[data-hash]'));
  return cards;
}

function observeTree(node) {
  if (!observer) return;
  for (const card of cardsIn(node)) {
    if (observed.has(card) || !kind(card)) continue;
    observed.add(card);
    observer.observe(card);
  }
}

function forgetTree(node) {
  if (!observer) return;
  for (const card of cardsIn(node)) {
    if (!observed.delete(card)) continue;
    nearby.delete(card);
    observer.unobserve(card);
  }
}

if (files) {
  for (const card of files.querySelectorAll('[data-hash]')) observeTree(card);
  const mutations = new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.removedNodes) forgetTree(node);
      for (const node of record.addedNodes) observeTree(node);
    }
  });
  mutations.observe(files, { childList: true, subtree: true });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      missRounds = 0;
      scheduleCheck();
    }
  });
}
