const files = document.querySelector('#files');
const THUMB_VERSION = 3;
const states = new Map();
let scanFrame = 0;
let requestTimer = 0;
const requested = new Map();
const pending = new Map();

function kind(card) {
  if (card.classList.contains('video-card')) return 'video';
  return card.classList.contains('media-card') ? 'image' : '';
}

function filename(card) {
  return card.title || card.querySelector('strong')?.textContent || '';
}

function visible(card) {
  const rect = card.getBoundingClientRect();
  return rect.bottom >= -200 && rect.top <= innerHeight + 200;
}

function thumbUrl(hash) {
  return `/api/thumbs/${hash}?v=${THUMB_VERSION}`;
}

function mediaBox(card) {
  return card.querySelector('.media-thumb');
}

function ensurePending(card) {
  const box = mediaBox(card);
  if (!box || box.querySelector('.cached-thumb')) return;
  if (!box.querySelector('.video-thumb-pending')) {
    const span = document.createElement('span');
    span.className = 'video-thumb-pending';
    span.dataset.videoThumb = card.dataset.hash || '';
    box.prepend(span);
  }
}

function apply(hash, source) {
  const cards = files.querySelectorAll(`[data-hash="${CSS.escape(hash)}"]`);
  for (const card of cards) {
    const box = mediaBox(card);
    if (!box) continue;
    const image = document.createElement('img');
    image.className = 'cached-thumb server-thumb';
    image.decoding = 'async';
    image.alt = filename(card);
    image.src = source.src;
    const old = box.querySelector('img,.video-thumb-pending');
    if (old) old.replaceWith(image);
    else box.prepend(image);
    if (source.naturalWidth && source.naturalHeight && card.classList.contains('media-card')) {
      const ratio = Math.max(.65, Math.min(2.1, source.naturalWidth / source.naturalHeight));
      card.style.setProperty('--ratio', ratio);
    }
  }
}

function queueRepair(card) {
  const hash = card.dataset.hash;
  const now = Date.now();
  if (!hash || now - (requested.get(hash) || 0) < 10_000) return;
  requested.set(hash, now);
  pending.set(hash, {
    hash,
    filename: filename(card),
    kind: kind(card),
    mime: `${kind(card)}/unknown`
  });
  if (!requestTimer) requestTimer = setTimeout(flushRepairs, 30);
}

async function flushRepairs() {
  requestTimer = 0;
  const batch = [...pending.values()].slice(0, 200);
  batch.forEach(item => pending.delete(item.hash));
  if (!batch.length) return;
  try {
    await fetch('/api/client/previews/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files: batch })
    });
  } catch {}
  if (pending.size) requestTimer = setTimeout(flushRepairs, 60);
}

function probe(card, force = false) {
  const hash = card.dataset.hash;
  if (!hash || !kind(card)) return;
  const state = states.get(hash) || {};
  const now = Date.now();
  if (state.ready || state.loading) return;
  if (!force && state.nextProbe && state.nextProbe > now) return;
  state.loading = true;
  states.set(hash, state);
  ensurePending(card);

  const image = new Image();
  image.decoding = 'async';
  image.onload = () => {
    states.set(hash, { ready: true, loading: false });
    requested.delete(hash);
    apply(hash, image);
  };
  image.onerror = () => {
    const latest = states.get(hash) || {};
    latest.loading = false;
    latest.ready = false;
    latest.nextProbe = Date.now() + 1800;
    states.set(hash, latest);
    if (visible(card)) queueRepair(card);
  };
  image.src = thumbUrl(hash);
}

function scan() {
  scanFrame = 0;
  if (document.hidden || !files) return;
  for (const card of files.querySelectorAll('.media-card[data-hash]')) {
    if (!visible(card)) continue;
    probe(card);
  }
}

function schedule() {
  if (!scanFrame) scanFrame = requestAnimationFrame(scan);
}

if (files) {
  new MutationObserver(schedule).observe(files, { childList: true, subtree: true });
  addEventListener('scroll', schedule, { passive: true });
  addEventListener('resize', schedule, { passive: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(); });
  setInterval(schedule, 1800);
  schedule();
}
