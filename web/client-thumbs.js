const files = document.querySelector('#files');
const THUMB_VERSION = 3;
const states = new Map();
const requestedAt = new Map();
let scanFrame = 0;
let checkTimer = 0;
let checking = false;

const kind = card => card.classList.contains('video-card') ? 'video' : card.classList.contains('media-card') ? 'image' : '';
const filename = card => card.dataset.filename || card.querySelector('strong')?.textContent || '';
const thumbUrl = hash => `/api/thumbs/${hash}?v=${THUMB_VERSION}`;

function visible(card) {
  const rect = card.getBoundingClientRect();
  return rect.bottom >= -200 && rect.top <= innerHeight + 200;
}

function cardsFor(hash) {
  return files.querySelectorAll(`[data-hash="${CSS.escape(hash)}"]`);
}

function ensurePending(card) {
  const box = card.querySelector('.media-thumb');
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
  state.loading = false;
  state.width = width || state.width || 0;
  state.height = height || state.height || 0;
  states.set(hash, state);
  applyDimensions(hash, state.width, state.height);

  for (const card of cardsFor(hash)) {
    const box = card.querySelector('.media-thumb');
    if (!box || box.querySelector('img.cached-thumb')) continue;
    const image = document.createElement('img');
    image.className = 'cached-thumb server-thumb';
    image.decoding = 'async';
    image.alt = filename(card);
    image.onload = () => {
      if (image.naturalWidth && image.naturalHeight) applyDimensions(hash, image.naturalWidth, image.naturalHeight);
    };
    image.onerror = () => {
      image.remove();
      const current = states.get(hash) || {};
      current.ready = false;
      current.loading = false;
      states.set(hash, current);
      scheduleCheck(300);
    };
    const old = box.querySelector('img,.video-thumb-pending');
    old ? old.replaceWith(image) : box.prepend(image);
    image.src = thumbUrl(hash);
  }
}

async function requestRepairs(cards) {
  const now = Date.now();
  const batch = [];
  for (const card of cards) {
    const hash = card.dataset.hash;
    if (!hash || now - (requestedAt.get(hash) || 0) < 10_000) continue;
    requestedAt.set(hash, now);
    batch.push({ hash, filename: filename(card), kind: kind(card), mime: `${kind(card)}/unknown` });
  }
  if (!batch.length) return;
  try {
    await fetch('/api/client/previews/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files: batch.slice(0, 200) })
    });
  } catch {}
}

async function checkVisible() {
  checkTimer = 0;
  if (checking || document.hidden || !files) return;
  const cards = [...files.querySelectorAll('.media-card[data-hash]')].filter(visible);
  if (!cards.length) return;

  const missingCards = [];
  const hashes = [];
  for (const card of cards) {
    const hash = card.dataset.hash;
    ensurePending(card);
    const state = states.get(hash) || {};
    if (state.ready) {
      applyReady(hash, state.width, state.height);
      continue;
    }
    if (!hashes.includes(hash)) hashes.push(hash);
    missingCards.push(card);
  }
  if (!hashes.length) return;

  checking = true;
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
      if (thumbnail) applyReady(hash, Number(thumbnail.width), Number(thumbnail.height));
      else {
        const state = states.get(hash) || {};
        state.ready = false;
        states.set(hash, state);
      }
    }
    await requestRepairs(missingCards.filter(card => !ready.has(card.dataset.hash)));
  } catch {}
  finally {
    checking = false;
    if ([...files.querySelectorAll('.media-card[data-hash]')].some(card => visible(card) && !states.get(card.dataset.hash)?.ready)) scheduleCheck(1200);
  }
}

function scheduleCheck(delay = 40) {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(checkVisible, delay);
}

function scan() {
  scanFrame = 0;
  if (document.hidden || !files) return;
  scheduleCheck(30);
}

function schedule() {
  if (!scanFrame) scanFrame = requestAnimationFrame(scan);
}

if (files) {
  new MutationObserver(schedule).observe(files, { childList: true, subtree: true });
  addEventListener('scroll', schedule, { passive: true });
  addEventListener('resize', schedule, { passive: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(); });
  schedule();
}
