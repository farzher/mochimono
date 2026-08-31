import './related-viewer.js';

const viewer = document.querySelector('#viewer');
const viewerOpen = document.querySelector('#viewer-open');
const viewerCollections = document.querySelector('#viewerCollections');
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
  const relative = String(source.path || '');
  const root = String(source.rootPath || '').replace(/[\\/]+$/, '');
  if (!root) return relative;
  const separator = root.includes('\\') ? '\\' : '/';
  return `${root}${separator}${relative.replace(/[\\/]+/g, separator)}`;
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

function protectionState(data, local) {
  const locals = localCopies(local);
  const localPaths = locals.reduce((sum, item) => sum + item.paths.length, 0);
  const backups = data.backups || [];
  const verified = backups.filter(backup => backup.verifiedAt);
  const server = data.serverStored !== false;
  const copies = localPaths + backups.length + (server ? 1 : 0);
  const safe = localPaths > 0 && server && verified.length > 0;

  if (safe) return {
    key: 'safe', label: `Safe to free · ${copies} copies`, title: 'Safe to free from this PC',
    note: 'A Mochimono copy and a verified backup both exist. Removing the local copy would still leave two known copies.',
    locals, backups, verified, server, copies, safe
  };
  if (localPaths > 0 && !server && !backups.length) return {
    key: 'danger', label: 'Only on this PC', title: 'Only on this PC',
    note: 'This is the only known copy. Keep it here until Mochimono has stored and backed it up.', locals, backups, verified, server, copies, safe
  };
  if (server && backups.length && localPaths > 0) return {
    key: 'warn', label: `Backup not verified · ${copies} copies`, title: 'Needs backup verification',
    note: 'Copies exist on this PC and in Mochimono, and a backup is present, but no backup copy has been verified yet.', locals, backups, verified, server, copies, safe
  };
  if (server && backups.length && !localPaths) return verified.length ? {
    key: 'good', label: `Protected · ${copies} copies`, title: 'Not on this PC',
    note: 'This file is not using local PC space. It remains in Mochimono and on a verified backup.', locals, backups, verified, server, copies, safe
  } : {
    key: 'warn', label: `Backup not verified · ${copies} copies`, title: 'Not on this PC',
    note: 'This file is not on this PC. A backup copy exists, but it has not been verified yet.', locals, backups, verified, server, copies, safe
  };
  if (server && localPaths > 0) return {
    key: 'warn', label: 'In Mochimono · backup needed', title: 'Needs another backup',
    note: 'The file exists on this PC and in Mochimono, but no independent backup copy is recorded.', locals, backups, verified, server, copies, safe
  };
  if (server) return {
    key: 'warn', label: 'Not on this PC · backup needed', title: 'Mochimono copy only',
    note: 'Mochimono has the file, but there is no indexed local or backup copy.', locals, backups, verified, server, copies, safe
  };
  if (localPaths > 0 && backups.length) return {
    key: 'warn', label: 'Not in Mochimono', title: 'Missing Mochimono copy',
    note: 'A local and backup copy exist, but this file is not currently stored in Mochimono.', locals, backups, verified, server, copies, safe
  };
  return {
    key: 'warn', label: `${Math.max(1, copies)} known copy`, title: 'Protection incomplete',
    note: 'Mochimono does not currently see enough independent copies to consider this file protected.', locals, backups, verified, server, copies, safe
  };
}

function copyCard(title, kind, detail = '', paths = []) {
  return `<article class="viewer-copy">
    <div class="viewer-copy-head"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(kind)}</span></div>
    ${paths.map(path => `<div class="viewer-info-path" title="${escapeHtml(path)}">${escapeHtml(path)}</div>`).join('')}
    ${detail ? `<small>${escapeHtml(detail)}</small>` : ''}
  </article>`;
}

function renderCopies(state) {
  const cards = [];
  for (const { location, paths } of state.locals) {
    const full = paths.map(path => fullPath({ rootPath: location.rootPath, path }));
    cards.push(copyCard(
      location.deviceName || 'This PC',
      location.protected === false ? `${location.name} · Browse only` : location.name || 'Local',
      location.available === false ? 'Folder is currently offline' : paths.length > 1 ? `${paths.length} paths` : 'Available now',
      full
    ));
  }
  if (state.server) cards.push(copyCard('Mochimono', 'Primary copy', 'Available'));
  for (const backup of state.backups) cards.push(copyCard(
    backup.name || 'Backup',
    'Backup copy',
    backup.verifiedAt ? `Verified ${formatDate(backup.verifiedAt)}` : backup.lastSeen ? `Seen ${formatDate(backup.lastSeen)} · not verified` : 'Stored · not verified'
  ));
  return cards.join('') || '<p class="viewer-info-empty">No accessible copy is recorded.</p>';
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
  return `<div class="viewer-tags">${chips}${editable ? '<button type="button" class="viewer-tag-add" data-add-group>+ Add</button>' : ''}</div>${!groups.length ? '<p class="viewer-info-empty">No tags or groups yet.</p>' : ''}`;
}

function renderPanel(data, local, groups) {
  const state = protectionState(data, local);
  const object = data.object || {};
  const sources = data.sources || [];
  const filename = object.filename || sources[0]?.filename || document.querySelector('#viewer-name')?.textContent || 'File';
  const mime = object.mime || 'application/octet-stream';
  const editableGroups = state.server;

  panel.innerHTML = `<div class="viewer-info-head"><div><strong>${escapeHtml(filename)}</strong><span>${escapeHtml(bytes(object.size))}</span></div><button type="button" data-info-close aria-label="Close details">×</button></div>
    <section class="viewer-protection ${state.key}">
      <span>Protection</span>
      <strong>${escapeHtml(state.title)}</strong>
      <p>${escapeHtml(state.note)}</p>
    </section>
    <section class="viewer-info-section">
      <h3>Copies</h3>
      ${renderCopies(state)}
    </section>
    <section class="viewer-info-section">
      <div class="viewer-section-head"><h3>Tags / groups</h3></div>
      ${renderGroups(groups, editableGroups)}
    </section>
    <section class="viewer-info-section viewer-origins">
      <h3>Origin</h3>
      ${renderOrigins(sources)}
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
  syncButton(state);
}

function syncButton(state) {
  if (!button || !state) return;
  button.textContent = state.label;
  button.classList.remove('protection-safe', 'protection-good', 'protection-warn', 'protection-danger');
  button.classList.add(`protection-${state.key}`);
  button.title = state.note;
}

async function clientLocations(hash) {
  try {
    const response = await fetch(`/api/client/locations?hash=${encodeURIComponent(hash)}`, { cache: 'no-store' });
    return response.ok ? await response.json() : { locations: [], files: [] };
  } catch {
    return { locations: [], files: [] };
  }
}

async function groupsFor(hash) {
  try {
    const response = await fetch(`/api/collections/file/${hash}`, { cache: 'no-store' });
    return response.ok ? (await response.json()).collections || [] : [];
  } catch { return []; }
}

async function load(render = !panel.hidden) {
  const hash = currentHash();
  const mine = ++generation;
  if (!hash) return;
  if (render) panel.innerHTML = '<div class="viewer-info-head"><div><strong>Details</strong></div><button type="button" data-info-close aria-label="Close details">×</button></div><p class="viewer-info-loading">Loading…</p>';
  try {
    const [response, local, groups] = await Promise.all([
      fetch(`/api/provenance/${hash}`, { cache: 'no-store' }),
      clientLocations(hash),
      render ? groupsFor(hash) : Promise.resolve([])
    ]);
    if (!response.ok) throw new Error(`${response.status}`);
    const data = await response.json();
    if (mine !== generation || hash !== currentHash()) return;
    const state = protectionState(data, local);
    syncButton(state);
    if (render && !panel.hidden) renderPanel(data, local, groups);
  } catch {
    if (mine !== generation) return;
    if (button) { button.textContent = 'Details'; button.title = 'File details'; }
    if (render && !panel.hidden) panel.insertAdjacentHTML('beforeend', '<p class="viewer-info-loading">Could not load file details.</p>');
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
  load(true);
}

button?.addEventListener('click', () => panel.hidden ? open() : close());
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
  if (event.key !== 'Escape' || panel.hidden) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  close();
}, true);

new MutationObserver(() => {
  if (viewer.hidden) {
    close();
    if (button) { button.textContent = 'Details'; button.title = 'File details'; }
  }
}).observe(viewer, { attributes: true, attributeFilter: ['hidden'] });

new MutationObserver(() => {
  if (!currentHash()) return;
  load(!panel.hidden);
}).observe(viewerOpen, { attributes: true, attributeFilter: ['href'] });

new MutationObserver(() => {
  if (!panel.hidden && currentHash()) {
    window.dispatchEvent(new CustomEvent('mochimono:groups-changed'));
    load(true);
  }
}).observe(viewerCollections, { childList: true, subtree: true });
