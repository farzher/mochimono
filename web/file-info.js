const CLIENT = document.documentElement.classList.contains('client-library');
const viewer = document.querySelector('#viewer');
const viewerOpen = document.querySelector('#viewer-open');
const viewerClose = document.querySelector('#viewer-close');
const viewerCollections = document.querySelector('#viewerCollections');
const viewerContext = document.querySelector('#viewer-context');
const button = document.querySelector('#viewer-info-button');
const panel = document.querySelector('#viewerInfo');
const summaryCache = new Map();
let generation = 0;

const style = document.createElement('style');
style.textContent = `
  .viewer-title{max-width:min(68vw,900px)}
  .viewer-title-sub{display:flex;align-items:center;gap:7px;min-width:0;height:18px}
  .viewer-context{display:flex;align-items:center;gap:4px;min-width:0;max-width:min(46vw,620px);overflow:hidden}
  .viewer-context:empty{display:none}
  .viewer-context-chip{display:block;min-width:0;max-width:220px;height:17px;padding:1px 6px;border:1px solid rgba(255,255,255,.11);border-radius:5px;background:rgba(16,16,16,.48);color:#d3ccca;font-size:9px;font-weight:650;line-height:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 3px #000;cursor:pointer}
  .viewer-context-chip:hover{background:rgba(255,255,255,.12);color:#fff}
  .viewer-context-chip.origin{color:#bcb3b1}
  .viewer-context-more{flex:0 0 auto;color:#aaa19f;font-size:9px;font-weight:700;white-space:nowrap}
  .viewer-title-sub>#viewer-meta{flex:0 0 auto;white-space:nowrap}
  @media(max-width:700px){
    .viewer-title{max-width:58vw}
    .viewer-context{max-width:38vw}
    .viewer-context-chip{max-width:130px}
    .viewer-context .viewer-context-chip:nth-of-type(n+2){display:none}
    .viewer-context-more{display:none}
  }
`;
document.head.append(style);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function currentHash() {
  return viewerOpen?.getAttribute('href')?.match(/\/api\/objects\/([a-f0-9]{64})/)?.[1] || '';
}

function formatDate(value) {
  if (!value) return 'Unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function bytes(number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = Number(number) || 0;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return `${value < 10 && unit ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function dateLabel(source) {
  return ({
    'exif.DateTimeOriginal': 'Taken',
    'exif.DateTimeDigitized': 'Created',
    'exif.DateTime': 'Image date',
    'video.creation_time': 'Created',
    'filesystem.mtime': 'Modified',
    imported: 'Added'
  })[source] || 'Date';
}

function fullPath(source) {
  const relative = String(source?.path || source?.originalPath || '');
  const root = String(source?.rootPath || '').replace(/[\\/]+$/, '');
  if (!root) return relative;
  if (!relative) return root;
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  const clean = relative.replace(/^[\\/]+/, '').replace(/[\\/]+/g, separator);
  return `${root}${separator}${clean}`;
}

function parentPath(value) {
  const raw = String(value || '').replace(/[\\/]+$/, '');
  const index = Math.max(raw.lastIndexOf('\\'), raw.lastIndexOf('/'));
  return index > 1 ? raw.slice(0, index) : raw;
}

function compactPath(value) {
  const raw = String(value || '');
  const separator = raw.includes('\\') && !raw.includes('/') ? '\\' : '/';
  const parts = raw.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 3) return raw;
  const prefix = /^[a-z]:$/i.test(parts[0]) ? `${parts[0]}${separator}` : raw.startsWith(separator) ? separator : '';
  return `${prefix}…${separator}${parts.slice(-2).join(separator)}`;
}

function unique(values) {
  const seen = new Set();
  const result = [];
  for (const value of values.map(item => String(item || '').trim()).filter(Boolean)) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function localCopies(local) {
  const definitions = new Map((local?.locations || []).map(location => [location.id, location]));
  const grouped = new Map();
  for (const [, id, relativePath] of local?.files || []) {
    const location = definitions.get(id);
    if (!location) continue;
    if (!grouped.has(id)) grouped.set(id, { location, paths: [] });
    grouped.get(id).paths.push(relativePath);
  }
  return [...grouped.values()];
}

function addContextChip(kind, value, label) {
  if (!viewerContext || !value) return;
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = `viewer-context-chip ${kind}`;
  chip.textContent = label;
  chip.title = kind === 'path' ? `${value}\nFilter to this folder` : `${value}\nFilter to this origin`;
  chip.dataset.contextKind = kind;
  chip.dataset.contextValue = value;
  viewerContext.append(chip);
}

function renderHeaderContext(data, local) {
  if (!viewerContext) return;
  viewerContext.replaceChildren();

  const localPaths = localCopies(local).flatMap(({ location, paths }) => paths.map(path => fullPath({ rootPath: location.rootPath, path })));
  const sourcePaths = (data.sources || []).map(fullPath);
  const folders = unique([...localPaths, ...sourcePaths].map(parentPath).filter(Boolean));
  const origins = unique((data.sources || []).map(source => source.sourceName || source.deviceName || ''));

  const entries = [
    ...folders.slice(0, 2).map(value => ({ kind: 'path', value, label: compactPath(value) })),
    ...origins.slice(0, 2).map(value => ({ kind: 'origin', value, label: value }))
  ];
  const shown = entries.slice(0, 3);
  for (const entry of shown) addContextChip(entry.kind, entry.value, entry.label);

  const total = folders.length + origins.length;
  if (total > shown.length) {
    const more = document.createElement('span');
    more.className = 'viewer-context-more';
    more.textContent = `+${total - shown.length}`;
    more.title = `${total - shown.length} more paths/origins`;
    viewerContext.append(more);
  }
}

function copyCard(title, kind, detail = '', paths = []) {
  return `<article class="viewer-copy">
    <div class="viewer-copy-head"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(kind)}</span></div>
    ${paths.map(path => `<div class="viewer-info-path" title="${escapeHtml(path)}">${escapeHtml(path)}</div>`).join('')}
    ${detail ? `<small>${escapeHtml(detail)}</small>` : ''}
  </article>`;
}

function renderCopies(data, local) {
  const cards = [];
  for (const { location, paths } of localCopies(local)) {
    const full = paths.map(path => fullPath({ rootPath: location.rootPath, path }));
    cards.push(copyCard(
      location.deviceName || 'This PC',
      location.protected === false ? `${location.name} · Browse only` : location.name || 'Local folder',
      location.available === false ? 'Offline' : paths.length > 1 ? `${paths.length} paths` : '',
      full
    ));
  }
  if (data.serverStored !== false) cards.push(copyCard('Cloud', 'Cloud copy'));
  for (const backup of data.backups || []) cards.push(copyCard(
    backup.name || 'Local backup',
    'Local backup',
    backup.verifiedAt ? `Verified ${formatDate(backup.verifiedAt)}` : backup.lastSeen ? `Seen ${formatDate(backup.lastSeen)}` : ''
  ));
  return cards.join('') || '<p class="viewer-info-empty">No known copy location.</p>';
}

function renderOrigins(sources) {
  if (!sources.length) return '<p class="viewer-info-empty">No origin history recorded.</p>';
  return sources.map(source => {
    const path = fullPath(source);
    return `<article class="viewer-origin">
      <strong>${escapeHtml(source.deviceName || source.sourceName || 'Origin')}</strong>
      ${path ? `<div class="viewer-info-path" title="${escapeHtml(path)}">${escapeHtml(path)}</div>` : ''}
      <small>${source.importedAt ? `Added ${escapeHtml(formatDate(source.importedAt))}` : ''}${source.mtime ? `${source.importedAt ? ' · ' : ''}Modified ${escapeHtml(formatDate(source.mtime))}` : ''}</small>
    </article>`;
  }).join('');
}

function renderGroups(groups, editable) {
  const chips = groups.map(group => `<span class="viewer-tag"><span>${escapeHtml(group.name)}</span>${editable ? `<button type="button" data-remove-group="${group.id}" aria-label="Remove ${escapeHtml(group.name)}">×</button>` : ''}</span>`).join('');
  return `<div class="viewer-tags">${chips}${editable ? '<button type="button" class="viewer-tag-add" data-add-group>+ Add</button>' : ''}</div>${!groups.length ? '<p class="viewer-info-empty">No groups.</p>' : ''}`;
}

function renderPanel(data, local, groups) {
  if (!panel) return;
  const object = data.object || {};
  const sources = data.sources || [];
  const filename = object.filename || sources[0]?.filename || document.querySelector('#viewer-name')?.textContent || 'File';
  const mime = object.mime || 'application/octet-stream';
  const editableGroups = data.serverStored !== false;

  panel.innerHTML = `<div class="viewer-info-head"><div><strong>${escapeHtml(filename)}</strong><span>${escapeHtml(bytes(object.size))}</span></div><button type="button" data-info-close aria-label="Close details">×</button></div>
    <section class="viewer-info-section">
      <h3>Where</h3>
      ${renderCopies(data, local)}
    </section>
    <section class="viewer-info-section viewer-origins">
      <h3>Origin</h3>
      ${renderOrigins(sources)}
    </section>
    <section class="viewer-info-section">
      <div class="viewer-section-head"><h3>Groups</h3></div>
      ${renderGroups(groups, editableGroups)}
    </section>
    <section class="viewer-info-section">
      <h3>Details</h3>
      <dl class="viewer-details">
        <div><dt>${escapeHtml(dateLabel(data.date?.dateSource))}</dt><dd>${escapeHtml(formatDate(data.date?.fileDate))}</dd></div>
        <div><dt>Type</dt><dd>${escapeHtml(mime)}</dd></div>
        <div><dt>Size</dt><dd>${escapeHtml(bytes(object.size))}</dd></div>
        <div><dt>SHA-256</dt><dd class="viewer-hash">${escapeHtml(object.hash || currentHash())}</dd></div>
      </dl>
    </section>`;
}

function trimCache() {
  while (summaryCache.size > 200) summaryCache.delete(summaryCache.keys().next().value);
}

async function clientLocations(hash) {
  if (!CLIENT) return { locations: [], files: [] };
  try {
    const response = await fetch(`/api/client/locations?hash=${encodeURIComponent(hash)}`, { cache: 'no-store' });
    return response.ok ? await response.json() : { locations: [], files: [] };
  } catch {
    return { locations: [], files: [] };
  }
}

async function summaryFor(hash, force = false) {
  if (!force && summaryCache.has(hash)) return summaryCache.get(hash);
  const promise = Promise.all([
    fetch(`/api/provenance/${hash}`, { cache: 'no-store' }).then(async response => response.ok ? await response.json() : null).catch(() => null),
    clientLocations(hash)
  ]).then(([data, local]) => ({
    data: data || {
      object: { hash, filename: document.querySelector('#viewer-name')?.textContent || 'File' },
      sources: [], backups: [], serverStored: false
    },
    local
  }));
  summaryCache.set(hash, promise);
  trimCache();
  return promise;
}

async function groupsFor(hash) {
  try {
    const response = await fetch(`/api/collections/file/${hash}`, { cache: 'no-store' });
    return response.ok ? (await response.json()).collections || [] : [];
  } catch { return []; }
}

async function load(render = Boolean(panel && !panel.hidden)) {
  const hash = currentHash();
  const mine = ++generation;
  if (!hash) return;
  if (render && panel) panel.innerHTML = '<div class="viewer-info-head"><div><strong>Details</strong></div><button type="button" data-info-close aria-label="Close details">×</button></div><p class="viewer-info-loading">Loading…</p>';
  try {
    const { data, local } = await summaryFor(hash);
    if (mine !== generation || hash !== currentHash()) return;
    renderHeaderContext(data, local);
    if (!render || !panel || panel.hidden) return;
    const groups = await groupsFor(hash);
    if (mine !== generation || hash !== currentHash() || panel.hidden) return;
    renderPanel(data, local, groups);
  } catch {
    if (mine !== generation) return;
    viewerContext?.replaceChildren();
    if (render && panel && !panel.hidden) panel.insertAdjacentHTML('beforeend', '<p class="viewer-info-loading">Could not load file details.</p>');
  }
}

function refresh() {
  viewerContext?.replaceChildren();
  if (!currentHash()) return;
  if (!viewer?.hidden && window.mochimonoViewerPerformance?.defer?.(refresh)) return;
  load(Boolean(panel && !panel.hidden));
}

function close() {
  generation++;
  if (panel) panel.hidden = true;
  viewer?.classList.remove('viewer-info-open');
  button?.classList.remove('active');
}

function open() {
  if (!currentHash() || !panel) return;
  document.querySelector('#viewer-menu')?.removeAttribute('open');
  panel.hidden = false;
  viewer?.classList.add('viewer-info-open');
  button?.classList.add('active');
  load(true);
}

button?.addEventListener('click', event => {
  event.preventDefault();
  panel?.hidden ? open() : close();
});

viewerContext?.addEventListener('click', event => {
  const chip = event.target.closest('[data-context-kind]');
  if (!chip) return;
  const value = String(chip.dataset.contextValue || '').replaceAll('"', '');
  if (!value || !window.mochimonoSearch?.setRaw) return;
  viewerClose?.click();
  const query = chip.dataset.contextKind === 'origin' ? `source:"${value}"` : `path:"${value}"`;
  requestAnimationFrame(() => window.mochimonoSearch.setRaw(query));
});

panel?.addEventListener('click', event => {
  if (event.target.closest('[data-info-close]')) return close();
  if (event.target.closest('[data-add-group]')) {
    const hash = currentHash();
    if (hash) window.dispatchEvent(new CustomEvent('mochimono:add-to-collection', { detail: { hashes: [hash] } }));
    return;
  }
  const remove = event.target.closest('[data-remove-group]');
  if (remove) {
    const id = remove.dataset.removeGroup;
    const existing = viewerCollections?.querySelector(`[data-remove-collection="${CSS.escape(id)}"]`);
    if (existing) existing.click();
    else fetch(`/api/collections/${encodeURIComponent(id)}/items/${currentHash()}`, { method: 'DELETE' }).then(() => {
      window.dispatchEvent(new CustomEvent('mochimono:groups-changed'));
      load(true);
    });
  }
});

document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || !panel || panel.hidden) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  close();
}, true);

if (viewer) new MutationObserver(() => {
  if (viewer.hidden) {
    close();
    viewerContext?.replaceChildren();
  }
}).observe(viewer, { attributes: true, attributeFilter: ['hidden'] });

if (viewerOpen) new MutationObserver(refresh).observe(viewerOpen, { attributes: true, attributeFilter: ['href'] });

if (viewerCollections) new MutationObserver(() => {
  if (panel && !panel.hidden && currentHash()) load(true);
}).observe(viewerCollections, { childList: true, subtree: true });

window.addEventListener('mochimono:locations-updated', () => {
  summaryCache.clear();
  if (!viewer?.hidden && currentHash()) refresh();
});
