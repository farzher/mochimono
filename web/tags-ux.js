const api = window.mochimonoTags;
if (!api) throw new Error('Tags UI loaded before tag support');

const commandbar = document.querySelector('.commandbar');
const filterMenu = document.querySelector('.library-filter-menu');
const viewer = document.querySelector('#viewer');
const viewerOpen = document.querySelector('#viewer-open');
const viewerActions = document.querySelector('.viewer-actions');
const viewerTags = document.querySelector('#viewerTags');
const manager = document.querySelector('.tag-manager');
const managerEditor = manager?.querySelector('.tag-editor');
const managerList = manager?.querySelector('.tag-list');

const style = document.createElement('style');
style.textContent = `
.command-tags{height:32px;min-width:46px;padding:0 9px;border:0;border-radius:8px;background:transparent;color:#a79e9a;font:700 10.5px/1 system-ui;cursor:pointer;flex:0 0 auto}.command-tags:hover,.command-tags:focus-visible{outline:0;background:#272328;color:#eee8e4}.command-tags.active{background:#eee8e4;color:#171416}
.viewer-action.viewer-tag-action{border:0;font:700 11px/1 system-ui;cursor:pointer}.viewer-action.viewer-tag-action[data-count]:not([data-count="0"]){color:#eee8e4}
.tag-quick-help{padding:9px 10px;border:1px solid rgba(255,255,255,.075);border-radius:9px;background:#111012;color:#928986;font:10.5px/1.5 system-ui}.tag-quick-help strong{color:#d8cfcb;font-weight:750}.tag-editor-toggle.tag-advanced-hidden{display:none!important}
.file-context-action[data-tag-context]{order:-1}
`;
document.head.append(style);

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;'
})[character]);

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    cache:'no-store',
    ...options,
    headers:{ 'content-type':'application/json', ...(options.headers || {}) },
    body:options.body == null || typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

// Tags should have an obvious home instead of living only inside the filter
// popover. This opens the same manager; filtering remains under Filters.
if (commandbar && !commandbar.querySelector('.command-tags')) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'command-tags';
  button.textContent = 'Tags';
  button.title = 'Manage tags and AI tagging';
  button.setAttribute('aria-label', button.title);
  button.addEventListener('click', () => api.open().catch?.(console.error));
  filterMenu?.before(button);
}

function currentHash() {
  return viewerOpen?.getAttribute('href')?.match(/\/api\/objects\/([a-f0-9]{64})/)?.[1] || '';
}

async function fileTagState(hash) {
  if (!hash) return [];
  try {
    const data = await requestJson(`/api/tags/file/${encodeURIComponent(hash)}`);
    return Array.isArray(data.tags) ? data.tags : [];
  } catch { return []; }
}

async function tagCount(hash) {
  const rows = await fileTagState(hash);
  return rows.filter(row => row.source).length;
}

// One-file manual tagging should be a first-class viewer action.
const viewerTagButton = document.createElement('button');
viewerTagButton.type = 'button';
viewerTagButton.className = 'viewer-action viewer-tag-action';
viewerTagButton.textContent = 'Tag';
viewerTagButton.title = 'Add or remove tags';
viewerTagButton.hidden = true;
viewerTagButton.addEventListener('click', () => {
  const hash = currentHash();
  if (hash) api.picker([hash]);
});
viewerActions?.insertBefore(viewerTagButton, viewerOpen);

let viewerSync = 0;
async function syncViewerTagButton() {
  const generation = ++viewerSync;
  const hash = currentHash();
  viewerTagButton.hidden = !hash || Boolean(viewer?.hidden);
  if (viewerTagButton.hidden) return;
  const count = await tagCount(hash);
  if (generation !== viewerSync || hash !== currentHash()) return;
  viewerTagButton.dataset.count = String(count);
  viewerTagButton.textContent = count ? `Tags · ${count}` : 'Tag';
}
new MutationObserver(syncViewerTagButton).observe(viewerOpen, { attributes:true, attributeFilter:['href'] });
new MutationObserver(syncViewerTagButton).observe(viewer, { attributes:true, attributeFilter:['hidden'] });
if (viewerTags) new MutationObserver(syncViewerTagButton).observe(viewerTags, { childList:true });
void syncViewerTagButton();

// Make membership provenance and AI-training role visible directly on a file.
let viewerRoleGeneration = 0;
let viewerRoleTimer = 0;
function sourceLabel(row) {
  if (row.source === 'manual') return 'Manual';
  if (row.source === 'system') return 'Automatic';
  if (row.source === 'ai') {
    const confidence = row.confidence == null ? '' : ` ${Math.round(Number(row.confidence) * 100)}%`;
    return `AI${confidence}`;
  }
  return '';
}
async function syncViewerRoles() {
  if (!viewerTags || viewer?.hidden) return;
  const hash = currentHash();
  if (!hash) return;
  const unenriched = viewerTags.querySelector('[data-filter-viewer-tag]:not([data-tag-ux-enriched])');
  if (!unenriched && viewerTags.dataset.trainingHash === hash) return;
  const generation = ++viewerRoleGeneration;
  const rows = await fileTagState(hash);
  if (generation !== viewerRoleGeneration || hash !== currentHash()) return;

  viewerTags.querySelectorAll('.viewer-tag-training-only').forEach(node => node.remove());
  for (const row of rows) {
    const id = String(row.id);
    const button = viewerTags.querySelector(`[data-filter-viewer-tag="${id}"]`);
    const role = Number(row.examplePolarity) === 1 ? 'Positive' : Number(row.examplePolarity) === -1 ? 'Negative' : '';
    if (button && row.source) {
      button.dataset.tagUxEnriched = '1';
      button.innerHTML = `${escapeHtml(row.name)}<small class="viewer-tag-origin ${row.source}">${escapeHtml(sourceLabel(row))}</small>${role ? `<small class="viewer-tag-role ${role.toLowerCase()}">${role}</small>` : ''}`;
      button.closest('.viewer-tag-chip')?.classList.toggle('ai', row.source !== 'manual');
      continue;
    }
    if (!row.source && role === 'Negative') {
      const chip = document.createElement('span');
      chip.className = 'viewer-tag-chip viewer-tag-training-only negative';
      chip.innerHTML = `<button type="button" data-open-training-tag="${id}" title="Negative training example for this tag">${escapeHtml(row.name)}<small class="viewer-tag-role negative">Negative example</small></button>`;
      viewerTags.querySelector('.viewer-tag-add')?.before(chip);
    }
  }
  viewerTags.dataset.trainingHash = hash;
}
function scheduleViewerRoles() {
  clearTimeout(viewerRoleTimer);
  viewerRoleTimer = setTimeout(() => syncViewerRoles().catch(console.warn), 25);
}
if (viewerTags) {
  new MutationObserver(scheduleViewerRoles).observe(viewerTags, { childList:true, subtree:true });
  viewerTags.addEventListener('click', event => {
    const button = event.target.closest('[data-open-training-tag]');
    if (!button) return;
    event.preventDefault();
    api.open(button.dataset.openTrainingTag).catch?.(console.error);
  });
}
new MutationObserver(scheduleViewerRoles).observe(viewerOpen, { attributes:true, attributeFilter:['href'] });
void scheduleViewerRoles();

// The grid already has a right-click menu. Add the action there too so manual
// tagging does not require entering selection mode or opening the viewer first.
function installContextTag() {
  const actions = document.querySelector('.file-context-actions');
  if (!actions || actions.querySelector('[data-tag-context]')) return Boolean(actions);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'file-context-action';
  button.dataset.tagContext = '1';
  button.innerHTML = '<i aria-hidden="true">#</i><span>Tag…</span>';
  button.addEventListener('pointerdown', () => {
    const card = document.activeElement?.closest?.('[data-hash]');
    button.dataset.hash = String(card?.dataset?.hash || '');
  });
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    const hash = String(button.dataset.hash || '');
    if (!/^[a-f0-9]{64}$/.test(hash)) return;
    document.querySelector('.file-context-menu')?.setAttribute('hidden', '');
    api.picker([hash]);
  });
  actions.prepend(button);
  return true;
}
if (!installContextTag()) {
  const contextObserver = new MutationObserver(() => {
    if (installContextTag()) contextObserver.disconnect();
  });
  contextObserver.observe(document.body, { childList:true, subtree:true });
}

const reviewMode = new Map();
let reviewGeneration = 0;

function managerTagId() {
  return String(managerList?.querySelector('[data-manage-tag].active')?.dataset.manageTag || '');
}

function examplesFromState(state, polarity) {
  return (state?.examples || []).filter(item => Number(item.polarity) === polarity).map(item => String(item.hash));
}

async function setTrainingRole(tagId, hash, role) {
  const state = await requestJson(`/api/tags/${tagId}`);
  const positive = new Set(examplesFromState(state, 1));
  const negative = new Set(examplesFromState(state, -1));
  positive.delete(hash);
  negative.delete(hash);
  if (role === 'positive') positive.add(hash);
  if (role === 'negative') negative.add(hash);
  await requestJson(`/api/tags/${tagId}/examples`, {
    method:'POST',
    body:{ positive:[...positive], negative:[...negative] }
  });
}

async function confirmMember(tagId, hash) {
  await requestJson(`/api/tags/${tagId}/members`, { method:'POST', body:{ hashes:[hash], source:'manual' } });
}

async function removeMember(tagId, hash) {
  await requestJson(`/api/tags/${tagId}/remove`, { method:'POST', body:{ hashes:[hash] } });
}

async function refreshManagerTag(tagId) {
  await api.refresh().catch(() => {});
  if (!manager?.open) return;
  const button = managerList?.querySelector(`[data-manage-tag="${tagId}"]`);
  button?.click();
  scheduleViewerRoles();
}

function reviewCard(item, mode, positive, negative) {
  const member = item.member || null;
  const hash = String(item.hash);
  const confidence = member?.confidence == null ? '' : ` ${Math.round(Number(member.confidence) * 100)}%`;
  const memberBadge = member ? `<span class="tag-review-badge ${member.source}">${member.source === 'manual' ? 'Manual' : member.source === 'system' ? 'Auto' : `AI${confidence}`}</span>` : '';
  const roleBadge = positive.has(hash)
    ? '<span class="tag-review-badge positive">Positive</span>'
    : negative.has(hash)
      ? '<span class="tag-review-badge negative">Negative</span>'
      : '';

  let actions = '';
  if (mode === 'positive') {
    actions = `<button type="button" data-review-action="neutral" data-hash="${hash}">Neutral</button><button type="button" data-review-action="negative" data-hash="${hash}">Wrong</button>`;
  } else if (mode === 'negative') {
    actions = `<button type="button" data-review-action="neutral" data-hash="${hash}">Neutral</button><button type="button" data-review-action="positive" data-hash="${hash}">Belongs</button>`;
  } else {
    actions = `${member?.source === 'manual' ? '' : `<button type="button" data-review-action="confirm" data-hash="${hash}">Confirm</button>`}<button type="button" data-review-action="negative" data-hash="${hash}">Wrong</button><button type="button" data-review-action="remove" data-hash="${hash}">Remove</button>`;
  }

  return `<article class="tag-review-card" data-review-hash="${hash}" title="${hash}">
    <div class="tag-review-thumb"><img loading="lazy" src="/api/thumbs/${hash}" alt=""></div>
    <div class="tag-review-badges">${memberBadge}${roleBadge}</div>
    <div class="tag-review-actions">${actions}</div>
  </article>`;
}

async function renderReview(fields) {
  const section = fields.querySelector('.tag-review');
  if (!section) return;
  const tagId = managerTagId();
  if (!tagId) { section.remove(); return; }
  const generation = ++reviewGeneration;
  section.innerHTML = '<div class="tag-review-loading">Loading examples…</div>';
  const state = await requestJson(`/api/tags/${tagId}`);
  if (generation !== reviewGeneration || tagId !== managerTagId() || !section.isConnected) return;

  const members = Array.isArray(state.members) ? state.members : [];
  const memberMap = new Map(members.map(member => [String(member.hash), member]));
  const positive = new Set(examplesFromState(state, 1));
  const negative = new Set(examplesFromState(state, -1));
  const modes = [
    ['tagged','Tagged',members.length],
    ['manual','Manual',members.filter(item => item.source === 'manual').length],
    ['ai','AI',members.filter(item => item.source !== 'manual').length],
    ['positive','Positive',positive.size],
    ['negative','Negative',negative.size]
  ];
  let mode = reviewMode.get(tagId) || 'tagged';
  if (!modes.some(item => item[0] === mode)) mode = 'tagged';

  let items;
  if (mode === 'manual') items = members.filter(member => member.source === 'manual').map(member => ({ hash:member.hash, member }));
  else if (mode === 'ai') items = members.filter(member => member.source !== 'manual').map(member => ({ hash:member.hash, member }));
  else if (mode === 'positive') items = [...positive].map(hash => ({ hash, member:memberMap.get(hash) || null }));
  else if (mode === 'negative') items = [...negative].map(hash => ({ hash, member:memberMap.get(hash) || null }));
  else items = members.map(member => ({ hash:member.hash, member }));

  section.innerHTML = `
    <div class="tag-review-head">
      <strong>Review</strong>
      <span>Membership and AI training are separate. Confirm = manual + positive; Wrong = negative.</span>
    </div>
    <div class="tag-review-tabs">${modes.map(([id,label,count]) => `<button type="button" class="${id === mode ? 'active' : ''}" data-review-mode="${id}">${label}<small>${count}</small></button>`).join('')}</div>
    <div class="tag-review-grid">${items.length ? items.map(item => reviewCard(item, mode, positive, negative)).join('') : '<div class="tag-review-empty">Nothing here.</div>'}</div>`;

  section.querySelector('.tag-review-tabs')?.addEventListener('click', event => {
    const button = event.target.closest('[data-review-mode]');
    if (!button) return;
    reviewMode.set(tagId, button.dataset.reviewMode);
    renderReview(fields).catch(console.error);
  });
  section.querySelector('.tag-review-grid')?.addEventListener('click', async event => {
    const button = event.target.closest('[data-review-action]');
    if (!button) return;
    const hash = String(button.dataset.hash || '');
    if (!hash) return;
    button.disabled = true;
    try {
      if (button.dataset.reviewAction === 'confirm') await confirmMember(tagId, hash);
      else if (button.dataset.reviewAction === 'remove') await removeMember(tagId, hash);
      else await setTrainingRole(tagId, hash, button.dataset.reviewAction);
      await refreshManagerTag(tagId);
    } catch (error) {
      console.error(error);
      button.disabled = false;
    }
  });
}

function installReview(fields) {
  if (fields.querySelector('.tag-review')) return;
  const section = document.createElement('section');
  section.className = 'tag-review';
  const status = fields.querySelector('.tag-ai-status');
  (status || fields.lastElementChild)?.after(section);
  renderReview(fields).catch(error => { section.innerHTML = `<div class="tag-review-empty">${escapeHtml(error.message)}</div>`; });
}

function decorateManagerList() {
  if (!managerList) return;
  const byId = new Map(api.tags().map(tag => [String(tag.id), tag]));
  for (const button of managerList.querySelectorAll('[data-manage-tag]')) {
    const tag = byId.get(String(button.dataset.manageTag));
    const small = button.querySelector('small');
    if (!tag || !small) continue;
    const text = `${Number(tag.count) || 0} · +${Number(tag.positiveExamples) || 0} −${Number(tag.negativeExamples) || 0}`;
    if (small.textContent !== text) small.textContent = text;
    button.title = `${Number(tag.manualCount) || 0} manual · ${(Number(tag.aiCount) || 0) + (Number(tag.systemCount) || 0)} AI · ${Number(tag.positiveExamples) || 0} positive · ${Number(tag.negativeExamples) || 0} negative examples`;
  }
}

function polishManager() {
  if (!managerEditor) return;
  const fields = managerEditor.querySelector('.tag-editor-fields');
  if (!fields) return;

  if (fields.dataset.simpleTags !== '1') {
    fields.dataset.simpleTags = '1';
    const help = document.createElement('div');
    help.className = 'tag-quick-help';
    help.innerHTML = '<strong>Manual:</strong> confirmed by you. &nbsp; <strong>AI:</strong> inferred. &nbsp; <strong>Positive / Negative:</strong> examples that teach the matcher.';
    fields.prepend(help);

    for (const span of fields.querySelectorAll('label > span')) {
      if (span.textContent.trim() === 'AI meaning') span.textContent = 'What belongs in this tag?';
    }
    const description = fields.querySelector('[data-edit-tag-description]');
    if (description) description.placeholder = 'Example: screenshots from Random TD, photos of my cat…';

    const toggle = fields.querySelector('.tag-editor-toggle');
    if (toggle) toggle.classList.add('tag-advanced-hidden');
    const save = fields.querySelector('[data-tag-save]');
    if (save) save.textContent = 'Save details';
    const find = fields.querySelector('[data-tag-ai-apply]');
    if (find) find.textContent = 'Find matching media';
    const yes = fields.querySelector('[data-tag-positive]');
    if (yes) yes.textContent = 'Selected belong';
    const no = fields.querySelector('[data-tag-negative]');
    if (no) no.textContent = 'Selected don’t belong';
    const clear = fields.querySelector('[data-tag-clear-ai]');
    if (clear) clear.textContent = 'Clear AI matches';
    const show = fields.querySelector('[data-tag-filter-current]');
    if (show) show.textContent = 'View tagged media';
  }

  installReview(fields);
  decorateManagerList();
}

if (manager) {
  const newInput = manager.querySelector('[data-tag-new]');
  if (newInput) newInput.placeholder = 'Create a tag…';
  const create = manager.querySelector('[data-tag-new-create]');
  if (create) { create.title = 'Create tag'; create.setAttribute('aria-label', 'Create tag'); }
  new MutationObserver(polishManager).observe(managerEditor, { childList:true, subtree:true });
  if (managerList) new MutationObserver(decorateManagerList).observe(managerList, { childList:true, subtree:true });
  polishManager();
  decorateManagerList();
}
