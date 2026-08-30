const viewer = document.querySelector('#viewer');
const viewerOpen = document.querySelector('#viewer-open');
const button = document.querySelector('#viewer-info-button');
const panel = document.querySelector('#viewerInfo');
let generation = 0;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function currentHash() {
  return viewerOpen.getAttribute('href')?.match(/\/api\/objects\/([a-f0-9]{64})/)?.[1] || '';
}

function formatDate(value) {
  if (!value) return 'Unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function dateLabel(source) {
  return ({
    'exif.DateTimeOriginal': 'Taken · EXIF original',
    'exif.DateTimeDigitized': 'Created · EXIF digitized',
    'exif.DateTime': 'Image metadata date',
    'video.creation_time': 'Created · video metadata',
    'filesystem.mtime': 'Earliest preserved modified date',
    imported: 'First imported'
  })[source] || 'Date';
}

function fullPath(source) {
  const relative = String(source.path || '');
  const root = String(source.rootPath || '').replace(/[\\/]+$/, '');
  if (!root) return relative;
  const separator = root.includes('\\') ? '\\' : '/';
  return `${root}${separator}${relative.replace(/[\\/]+/g, separator)}`;
}

function sourceCard(source) {
  const path = fullPath(source);
  const title = source.deviceName || source.sourceName || 'Source';
  return `<article class="viewer-info-source">
    <strong>${escapeHtml(title)}</strong>
    ${path ? `<div class="viewer-info-path" title="${escapeHtml(path)}">${escapeHtml(path)}</div>` : ''}
    <dl>
      <div><dt>Modified</dt><dd>${escapeHtml(formatDate(source.mtime))}</dd></div>
      <div><dt>Imported</dt><dd>${escapeHtml(formatDate(source.importedAt))}</dd></div>
    </dl>
  </article>`;
}

function render(data) {
  const sources = data.sources || [];
  panel.innerHTML = `<div class="viewer-info-head"><strong>Info</strong><button type="button" data-info-close aria-label="Close info">×</button></div>
    <section class="viewer-info-date">
      <span>${escapeHtml(dateLabel(data.date?.dateSource))}</span>
      <strong>${escapeHtml(formatDate(data.date?.fileDate))}</strong>
    </section>
    <section class="viewer-info-sources">
      <h3>${sources.length > 1 ? `${sources.length} source copies` : 'Source'}</h3>
      ${sources.length ? sources.map(sourceCard).join('') : '<p>No provenance recorded.</p>'}
    </section>`;
}

async function load() {
  const hash = currentHash();
  const mine = ++generation;
  if (!hash || panel.hidden) return;
  panel.innerHTML = '<div class="viewer-info-head"><strong>Info</strong><button type="button" data-info-close aria-label="Close info">×</button></div><p class="viewer-info-loading">Loading…</p>';
  try {
    const response = await fetch(`/api/provenance/${hash}`);
    if (!response.ok) throw new Error(`${response.status}`);
    const data = await response.json();
    if (mine !== generation || panel.hidden || hash !== currentHash()) return;
    render(data);
  } catch {
    if (mine === generation && !panel.hidden) panel.insertAdjacentHTML('beforeend', '<p class="viewer-info-loading">Could not load file info.</p>');
  }
}

function close() {
  generation++;
  panel.hidden = true;
  viewer.classList.remove('viewer-info-open');
  button?.classList.remove('active');
}

function open() {
  if (!currentHash()) return;
  panel.hidden = false;
  viewer.classList.add('viewer-info-open');
  button?.classList.add('active');
  load();
}

button?.addEventListener('click', () => panel.hidden ? open() : close());
panel?.addEventListener('click', event => {
  if (event.target.closest('[data-info-close]')) close();
});

document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || panel.hidden) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  close();
}, true);

new MutationObserver(() => {
  if (viewer.hidden) close();
}).observe(viewer, { attributes: true, attributeFilter: ['hidden'] });

new MutationObserver(() => {
  if (!panel.hidden) load();
}).observe(viewerOpen, { attributes: true, attributeFilter: ['href'] });
