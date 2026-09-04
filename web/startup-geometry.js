const files = document.querySelector('#files');
const originalReady = window.mochimonoInstantGridReady || Promise.resolve(false);
const geometry = new Map();

function apply(card, width, height) {
  width = Number(width) || 0;
  height = Number(height) || 0;
  if (!card || !width || !height) return false;
  card.dataset.width = String(width);
  card.dataset.height = String(height);
  card.style.setProperty('--ratio', String(width / height));
  return true;
}

function applyKnown(node) {
  if (!(node instanceof Element)) return;
  const cards = [];
  if (node.matches('[data-hash]')) cards.push(node);
  cards.push(...node.querySelectorAll('[data-hash]'));
  for (const card of cards) {
    if (Number(card.dataset.width) > 0 && Number(card.dataset.height) > 0) continue;
    const known = geometry.get(String(card.dataset.hash || ''));
    if (known) apply(card, known.width, known.height);
  }
}

const observer = files ? new MutationObserver(records => {
  for (const record of records) for (const node of record.addedNodes) applyKnown(node);
}) : null;
observer?.observe(files, { childList: true, subtree: true });

async function prime() {
  const cards = [...files.querySelectorAll('[data-instant-hash]')];
  const hashes = [...new Set(cards.map(card => String(card.dataset.instantHash || '')).filter(hash => /^[a-f0-9]{64}$/.test(hash)))];
  if (!hashes.length) return;

  try {
    const response = await fetch('/api/thumbs/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hashes })
    });
    if (!response.ok) return;
    const data = await response.json();
    for (const item of data.thumbnails || []) {
      const hash = String(item.hash || '');
      const width = Number(item.width) || 0;
      const height = Number(item.height) || 0;
      if (!hash || !width || !height) continue;
      geometry.set(hash, { width, height });
      const instant = files.querySelector(`[data-instant-hash="${CSS.escape(hash)}"]`);
      apply(instant, width, height);
    }
  } catch {}

  // catalog-cache is the next module in the page and is normally installed by
  // the time this local metadata request finishes. Persist what we learned so
  // future cold starts do not need to rediscover the same geometry.
  setTimeout(() => {
    for (const [hash, item] of geometry) window.mochimonoCatalogCache?.rememberDimensions?.(hash, item.width, item.height);
  }, 0);
}

window.mochimonoStartupGeometry = geometry;
window.mochimonoInstantGridReady = Promise.resolve(originalReady).then(async painted => {
  if (painted) await prime();
  return painted;
});
