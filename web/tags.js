const files = document.querySelector('#files');
const viewer = document.querySelector('#viewer');
const viewerOpen = document.querySelector('#viewer-open');
const viewerCollections = document.querySelector('#viewerCollections');
const filterPopover = document.querySelector('.library-filter-popover');
const collectionFilter = document.querySelector('#collectionFilter');
const selectionBar = document.querySelector('#selectionBar');
const selectionSpacer = selectionBar?.querySelector('.selection-spacer');
const SENSITIVE_MODE_KEY = 'mochimono-sensitive-media-mode';
const AI_LIMIT = 500;

let tags = [];
let tagStates = new Map();
let tagFilterId = '';
let sensitiveMode = ['hide','blur','show'].includes(localStorage.getItem(SENSITIVE_MODE_KEY)) ? localStorage.getItem(SENSITIVE_MODE_KEY) : 'hide';
let pickerHashes = [];
let managerTagId = '';
let suggestions = [];
let allHashesCache = null;
let scopeGeneration = 0;
let scopeTimer = 0;
let decorateFrame = 0;
let viewerGeneration = 0;
let lastExperimental = document.documentElement.classList.contains('experimental-view-active');

const originalSetCollectionHashes = window.mochimonoSetCollectionHashes?.bind(window) || null;
let baseCollectionHashes = null;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));
}

async function json(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers:{ 'content-type':'application/json', ...(options.headers || {}) },
    body:options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try { message = (await response.json()).error || message; } catch {}
    throw new Error(message);
  }
  return response.json();
}

function currentViewerHash() {
  return viewerOpen?.getAttribute('href')?.match(/\/api\/objects\/([a-f0-9]{64})/)?.[1] || '';
}

function selectedHashes() {
  const selected = window.mochimonoSelection?.hashes?.() || [];
  if (selected.length) return selected;
  const hash = currentViewerHash();
  return hash ? [hash] : [];
}

function tagById(id) { return tags.find(item => String(item.id) === String(id)); }
function sensitiveTag() { return tags.find(item => String(item.name).toLowerCase() === 'sensitive'); }
function setForState(state) { return new Set((state?.members || []).map(item => String(item.hash))); }

async function loadTagState(id, force = false) {
  id = String(id || '');
  if (!id) return null;
  if (!force && tagStates.has(id)) return tagStates.get(id);
  const state = await json(`/api/tags/${encodeURIComponent(id)}`);
  tagStates.set(id, state);
  return state;
}

function renderTagFilter() {
  if (!tagSelect) return;
  const wanted = tagFilterId;
  tagSelect.innerHTML = '<option value="">All tags</option>' + tags.map(tag =>
    `<option value="${tag.id}">${escapeHtml(tag.name)}${tag.count ? ` · ${Number(tag.count).toLocaleString()}` : ''}</option>`
  ).join('');
  tagSelect.value = tagById(wanted) ? String(wanted) : '';
  tagFilterId = tagSelect.value;
}

async function refreshTags(forceState = false) {
  const data = await json('/api/tags');
  tags = data.tags || [];
  if (forceState) tagStates.clear();
  else {
    const valid = new Set(tags.map(tag => String(tag.id)));
    for (const id of [...tagStates.keys()]) if (!valid.has(id)) tagStates.delete(id);
  }
  renderTagFilter();
  renderManagerList();
  return tags;
}

async function allCatalogHashes() {
  if (allHashesCache) return new Set(allHashesCache);
  const hashes = new Set();
  try {
    const snapshot = await window.mochimonoCatalogCache?.load?.();
    for (const file of snapshot?.files || []) if (/^[a-f0-9]{64}$/.test(String(file?.hash || ''))) hashes.add(String(file.hash));
  } catch {}
  const expected = Number(window.mochimonoLibrary?.state?.()?.total) || 0;
  if (!hashes.size || hashes.size < expected) {
    try {
      let after = '';
      do {
        const page = await json(`/api/catalog?limit=5000&after=${encodeURIComponent(after)}`);
        for (const file of page.files || []) if (/^[a-f0-9]{64}$/.test(String(file?.hash || ''))) hashes.add(String(file.hash));
        after = page.nextAfter || '';
      } while (after);
    } catch {}
    for (const hash of window.mochimonoLibrary?.filteredHashes?.() || []) hashes.add(String(hash));
  }
  allHashesCache = hashes;
  return new Set(hashes);
}

function intersect(left, right) {
  if (!left) return new Set(right || []);
  if (!right) return new Set(left);
  const out = new Set();
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  for (const value of small) if (large.has(value)) out.add(value);
  return out;
}

function experimentalActive() { return document.documentElement.classList.contains('experimental-view-active'); }
function sensitiveShouldHide() { return sensitiveMode === 'hide' || (sensitiveMode === 'blur' && experimentalActive()); }

async function applyCombinedScope() {
  if (!originalSetCollectionHashes) return;
  const generation = ++scopeGeneration;
  let scope = baseCollectionHashes ? new Set(baseCollectionHashes) : null;

  if (tagFilterId) {
    try {
      const state = await loadTagState(tagFilterId);
      if (generation !== scopeGeneration) return;
      scope = intersect(scope, setForState(state));
    } catch (error) { console.warn('Could not apply tag filter.', error); }
  }

  if (sensitiveShouldHide()) {
    const tag = sensitiveTag();
    if (tag) {
      try {
        const state = await loadTagState(tag.id);
        if (generation !== scopeGeneration) return;
        const hidden = setForState(state);
        if (hidden.size) {
          if (!scope) scope = await allCatalogHashes();
          if (generation !== scopeGeneration) return;
          for (const hash of hidden) scope.delete(hash);
        }
      } catch (error) { console.warn('Could not apply sensitive-media filter.', error); }
    }
  }

  if (generation !== scopeGeneration) return;
  originalSetCollectionHashes(scope);
  updateSensitivePresentation();
}

function scheduleScope(delay = 0) {
  clearTimeout(scopeTimer);
  scopeTimer = setTimeout(() => { scopeTimer = 0; applyCombinedScope().catch(console.error); }, delay);
}

if (originalSetCollectionHashes) {
  window.mochimonoSetCollectionHashes = hashes => {
    baseCollectionHashes = hashes instanceof Set ? new Set(hashes) : hashes ? new Set(hashes) : null;
    originalSetCollectionHashes(hashes);
    scheduleScope(0);
  };
}

const tagLabel = document.createElement('label');
tagLabel.innerHTML = '<span>Tags</span><select id="tagFilter" aria-label="Tags"><option value="">All tags</option></select>';
const tagSelect = tagLabel.querySelector('select');
const sensitiveLabel = document.createElement('label');
sensitiveLabel.innerHTML = `<span>Sensitive</span><select id="sensitiveMediaMode" aria-label="Sensitive media"><option value="hide">Hide</option><option value="blur">Blur</option><option value="show">Show</option></select>`;
const sensitiveSelect = sensitiveLabel.querySelector('select');
sensitiveSelect.value = sensitiveMode;
const filterActions = document.createElement('div');
filterActions.className = 'tag-filter-actions';
filterActions.innerHTML = '<button type="button" data-manage-tags>Manage tags</button><button type="button" data-scan-sensitive>Scan sensitive</button>';
filterPopover?.append(tagLabel, sensitiveLabel, filterActions);

tagSelect.addEventListener('change', () => {
  tagFilterId = tagSelect.value;
  scheduleScope();
  window.dispatchEvent(new CustomEvent('mochimono:filters-changed'));
});
sensitiveSelect.addEventListener('change', () => {
  sensitiveMode = sensitiveSelect.value;
  localStorage.setItem(SENSITIVE_MODE_KEY, sensitiveMode);
  scheduleScope();
  updateSensitivePresentation();
});

const selectionTags = document.createElement('button');
selectionTags.type = 'button';
selectionTags.className = 'selection-tags';
selectionTags.textContent = 'Tag';
selectionTags.title = 'Tag selected files';
selectionTags.hidden = false;
selectionSpacer?.before(selectionTags);
selectionTags.addEventListener('click', () => {
  const hashes = window.mochimonoSelection?.hashes?.() || [];
  if (hashes.length) openPicker(hashes);
});

const viewerTags = document.createElement('div');
viewerTags.className = 'viewer-tags';
viewerTags.id = 'viewerTags';
viewerCollections?.after(viewerTags);

const picker = document.createElement('dialog');
picker.className = 'tag-picker';
picker.innerHTML = `
  <div class="tag-picker-card">
    <div class="tag-picker-head"><strong>Tags</strong><button type="button" data-tag-picker-close aria-label="Close">×</button></div>
    <input data-tag-picker-input type="text" maxlength="80" autocomplete="off" placeholder="Find or create a tag">
    <div class="tag-picker-options"></div>
    <button type="button" class="tag-picker-create" data-tag-picker-create hidden></button>
  </div>`;
document.body.append(picker);
const pickerInput = picker.querySelector('[data-tag-picker-input]');
const pickerOptions = picker.querySelector('.tag-picker-options');
const pickerCreate = picker.querySelector('[data-tag-picker-create]');

async function pickerMemberships() {
  const wanted = new Set(pickerHashes);
  const states = await Promise.all(tags.map(tag => loadTagState(tag.id).catch(() => null)));
  return new Map(tags.map((tag, index) => {
    const state = states[index];
    const members = new Set((state?.members || []).map(item => item.hash));
    let count = 0;
    for (const hash of wanted) if (members.has(hash)) count++;
    return [String(tag.id), { state, count, all:Boolean(wanted.size && count === wanted.size) }];
  }));
}

async function renderPicker() {
  const memberships = await pickerMemberships();
  const query = pickerInput.value.trim().toLowerCase();
  const matching = tags.filter(tag => !query || tag.name.toLowerCase().includes(query));
  pickerOptions.innerHTML = matching.map(tag => {
    const membership = memberships.get(String(tag.id));
    return `<button type="button" data-picker-tag="${tag.id}" class="${membership?.all ? 'active' : ''}"><span>${escapeHtml(tag.name)}</span><small>${membership?.count ? `${membership.count}/${pickerHashes.length}` : Number(tag.count || 0).toLocaleString()}</small></button>`;
  }).join('');
  const exact = query && tags.some(tag => tag.name.toLowerCase() === query);
  pickerCreate.hidden = !query || exact;
  pickerCreate.textContent = query && !exact ? `Create “${pickerInput.value.trim()}”` : '';
}

async function openPicker(hashes) {
  pickerHashes = [...new Set((hashes || []).map(String).filter(hash => /^[a-f0-9]{64}$/.test(hash)))];
  if (!pickerHashes.length) return;
  await refreshTags().catch(() => {});
  pickerInput.value = '';
  await renderPicker();
  picker.showModal();
  pickerInput.focus();
}

async function afterTagMutation() {
  tagStates.clear();
  allHashesCache = null;
  await refreshTags().catch(console.warn);
  scheduleScope();
  scheduleDecorate();
  renderViewerTags().catch(() => {});
  if (picker.open) renderPicker().catch(() => {});
  if (manager.open) renderManagerEditor().catch(() => {});
}

pickerInput.addEventListener('input', () => renderPicker().catch(console.error));
picker.querySelector('[data-tag-picker-close]').addEventListener('click', () => picker.close());
picker.addEventListener('click', event => { if (event.target === picker) picker.close(); });
pickerOptions.addEventListener('click', async event => {
  const button = event.target.closest('[data-picker-tag]');
  if (!button) return;
  const id = button.dataset.pickerTag;
  const state = await loadTagState(id, true);
  const members = new Set((state.members || []).map(item => item.hash));
  const remove = pickerHashes.every(hash => members.has(hash));
  if (remove) await json(`/api/tags/${id}/remove`, { method:'POST', body:{ hashes:pickerHashes, suppress:true } });
  else await json(`/api/tags/${id}/members`, { method:'POST', body:{ hashes:pickerHashes, source:'manual' } });
  await afterTagMutation();
});
pickerCreate.addEventListener('click', async () => {
  const name = pickerInput.value.trim();
  if (!name) return;
  const created = await json('/api/tags', { method:'POST', body:{ name } });
  await json(`/api/tags/${created.tag.id}/members`, { method:'POST', body:{ hashes:pickerHashes, source:'manual' } });
  pickerInput.value = '';
  await afterTagMutation();
});

async function viewerFileTags(hash) {
  if (!hash) return [];
  try { return (await json(`/api/files/${hash}/details`)).tags || []; }
  catch { return []; }
}

async function renderViewerTags() {
  const hash = currentViewerHash();
  const generation = ++viewerGeneration;
  if (!hash || viewer?.hidden) { viewerTags.replaceChildren(); viewer?.classList.remove('sensitive-current'); return; }
  const memberships = await viewerFileTags(hash);
  if (generation !== viewerGeneration || hash !== currentViewerHash() || viewer.hidden) return;
  viewerTags.innerHTML = memberships.map(item => {
    const ai = item.source !== 'manual';
    const confidence = item.confidence == null ? '' : ` · ${Math.round(Number(item.confidence) * 100)}%`;
    const title = `${ai ? item.source === 'system' ? 'Automatic' : 'AI' : 'Manual'}${confidence}`;
    return `<span class="viewer-tag-chip ${ai ? 'ai' : ''} ${String(item.name).toLowerCase() === 'sensitive' ? 'sensitive' : ''}" title="${escapeHtml(title)}"><button type="button" data-filter-viewer-tag="${item.id}">${ai ? '✦ ' : ''}${escapeHtml(item.name)}</button><button type="button" data-remove-viewer-tag="${item.id}" aria-label="Remove ${escapeHtml(item.name)}">×</button></span>`;
  }).join('') + '<button type="button" class="viewer-tag-add" data-add-viewer-tag>+ Tag</button>';
  const sensitive = memberships.some(item => String(item.name).toLowerCase() === 'sensitive');
  viewer.classList.toggle('sensitive-current', sensitive && sensitiveMode === 'blur');
}

viewerTags.addEventListener('click', async event => {
  const add = event.target.closest('[data-add-viewer-tag]');
  if (add) { const hash = currentViewerHash(); if (hash) openPicker([hash]); return; }
  const filter = event.target.closest('[data-filter-viewer-tag]');
  if (filter) {
    tagFilterId = String(filter.dataset.filterViewerTag || '');
    tagSelect.value = tagFilterId;
    viewer.querySelector('#viewer-close')?.click();
    scheduleScope();
    return;
  }
  const remove = event.target.closest('[data-remove-viewer-tag]');
  if (!remove) return;
  const hash = currentViewerHash();
  if (!hash) return;
  await json(`/api/tags/${remove.dataset.removeViewerTag}/remove`, { method:'POST', body:{ hashes:[hash], suppress:true } });
  await afterTagMutation();
});
new MutationObserver(() => renderViewerTags().catch(() => {})).observe(viewerOpen, { attributes:true, attributeFilter:['href'] });
new MutationObserver(() => renderViewerTags().catch(() => {})).observe(viewer, { attributes:true, attributeFilter:['hidden'] });

function sensitiveHashesCached() {
  const tag = sensitiveTag();
  if (!tag) return new Set();
  return setForState(tagStates.get(String(tag.id)));
}

function decorateSensitive() {
  decorateFrame = 0;
  const hidden = sensitiveHashesCached();
  if (!hidden.size) return;
  for (const card of files?.querySelectorAll?.('[data-hash]') || []) card.dataset.sensitive = hidden.has(card.dataset.hash) ? '1' : '0';
}

function scheduleDecorate() {
  if (!decorateFrame) decorateFrame = requestAnimationFrame(decorateSensitive);
}

function updateSensitivePresentation() {
  document.documentElement.classList.toggle('mochimono-sensitive-blur', sensitiveMode === 'blur' && !experimentalActive());
  const current = currentViewerHash();
  viewer?.classList.toggle('sensitive-current', sensitiveMode === 'blur' && sensitiveHashesCached().has(current));
  scheduleDecorate();
}

new MutationObserver(scheduleDecorate).observe(files, { childList:true, subtree:true });
new MutationObserver(() => {
  const active = experimentalActive();
  if (active === lastExperimental) return;
  lastExperimental = active;
  updateSensitivePresentation();
  scheduleScope();
}).observe(document.documentElement, { attributes:true, attributeFilter:['class'] });

const manager = document.createElement('dialog');
manager.className = 'tag-manager';
manager.innerHTML = `
  <div class="tag-manager-card">
    <div class="tag-manager-head"><strong>Tags</strong><button type="button" data-tag-manager-close aria-label="Close">×</button></div>
    <aside class="tag-manager-sidebar">
      <div class="tag-new"><input type="text" data-tag-new maxlength="80" placeholder="New tag"><button type="button" data-tag-new-create aria-label="Create tag">+</button></div>
      <div class="tag-list"></div>
      <button type="button" class="tag-suggest" data-tag-suggest>Suggest tags with AI</button>
    </aside>
    <section class="tag-editor"><div class="tag-editor-empty">Choose a tag.</div></section>
  </div>`;
document.body.append(manager);
const managerList = manager.querySelector('.tag-list');
const managerEditor = manager.querySelector('.tag-editor');
const managerNew = manager.querySelector('[data-tag-new]');

function renderManagerList() {
  if (!managerList) return;
  managerList.innerHTML = tags.map(tag => `<button type="button" data-manage-tag="${tag.id}" class="${String(tag.id) === String(managerTagId) ? 'active' : ''}"><span>${tag.builtin ? '✦ ' : ''}${escapeHtml(tag.name)}</span><small>${Number(tag.count || 0).toLocaleString()}</small></button>`).join('');
}

function aiProgress(text) {
  const status = managerEditor.querySelector('.tag-ai-status');
  if (!status) return;
  status.textContent = text || '';
  status.classList.toggle('busy', Boolean(text));
}

function exampleHashes(state, polarity) {
  return (state?.examples || []).filter(item => Number(item.polarity) === polarity).map(item => String(item.hash));
}

async function renderManagerEditor() {
  const tag = tagById(managerTagId);
  if (!tag) { managerEditor.innerHTML = '<div class="tag-editor-empty">Choose a tag.</div>'; return; }
  const state = await loadTagState(tag.id, true);
  const positives = exampleHashes(state, 1);
  const negatives = exampleHashes(state, -1);
  const sensitive = String(tag.name).toLowerCase() === 'sensitive';
  managerEditor.innerHTML = `
    <div class="tag-editor-fields">
      <label><span>Name</span><input data-edit-tag-name maxlength="80" value="${escapeHtml(tag.name)}" ${tag.builtin ? 'disabled' : ''}></label>
      <label><span>AI meaning</span><textarea data-edit-tag-description maxlength="500" placeholder="Describe what belongs in this tag">${escapeHtml(tag.description || '')}</textarea></label>
      <label class="tag-editor-toggle"><input data-edit-tag-ai type="checkbox" ${tag.aiEnabled ? 'checked' : ''}><span>AI-assisted</span></label>
      <div class="tag-editor-meta">${Number(tag.count || 0).toLocaleString()} tagged · ${Number(tag.manualCount || 0).toLocaleString()} manual · ${(Number(tag.aiCount || 0) + Number(tag.systemCount || 0)).toLocaleString()} AI</div>
      <div class="tag-example-list"><span>${positives.length} positive examples</span><span>${negatives.length} negative examples</span><span>${Number(tag.suppressed || 0)} corrections</span></div>
      <div class="tag-editor-actions">
        <button type="button" class="primary" data-tag-save>Save</button>
        ${sensitive ? '<button type="button" data-tag-sensitive-scan>Scan sensitive</button>' : '<button type="button" data-tag-ai-apply>Find + apply with AI</button>'}
        <button type="button" data-tag-positive>Selected = yes</button>
        <button type="button" data-tag-negative>Selected = no</button>
        <button type="button" data-tag-clear-ai>Clear AI guesses</button>
        <button type="button" data-tag-filter-current>Show this tag</button>
        ${tag.builtin ? '' : '<button type="button" class="danger" data-tag-delete>Delete tag</button>'}
      </div>
      <div class="tag-ai-status"></div>
      <div class="tag-suggestions"></div>
    </div>`;
}

async function openManager(id = '') {
  await refreshTags().catch(error => { console.warn(error); });
  managerTagId = id && tagById(id) ? String(id) : String(tags[0]?.id || '');
  suggestions = [];
  renderManagerList();
  await renderManagerEditor();
  manager.showModal();
}

manager.querySelector('[data-tag-manager-close]').addEventListener('click', () => manager.close());
manager.addEventListener('click', event => { if (event.target === manager) manager.close(); });
managerList.addEventListener('click', event => {
  const button = event.target.closest('[data-manage-tag]');
  if (!button) return;
  managerTagId = String(button.dataset.manageTag);
  renderManagerList();
  renderManagerEditor().catch(console.error);
});
manager.querySelector('[data-tag-new-create]').addEventListener('click', async () => {
  const name = managerNew.value.trim();
  if (!name) return;
  const result = await json('/api/tags', { method:'POST', body:{ name, aiEnabled:false } });
  managerNew.value = '';
  managerTagId = String(result.tag.id);
  await afterTagMutation();
  renderManagerList();
  await renderManagerEditor();
});
managerNew.addEventListener('keydown', event => { if (event.key === 'Enter') manager.querySelector('[data-tag-new-create]').click(); });

async function ensureAi() {
  const module = await import('./ai-engine.js');
  return module.default || window.mochimonoAI;
}

function adaptiveSemanticMatches(matches) {
  const list = (matches || []).filter(item => Number.isFinite(Number(item.similarity))).sort((a, b) => Number(b.similarity) - Number(a.similarity));
  if (!list.length) return [];
  const calibrated = list.filter(item => Number.isFinite(Number(item.relevance)));
  if (calibrated.length) {
    return calibrated.map(item => ({
      hash:String(item.hash),
      confidence:Math.max(.58, Math.min(.98, .62 + Number(item.relevance) * .34)),
      similarity:Number(item.similarity),
      relevance:Number(item.relevance)
    }));
  }
  const best = Number(list[0].similarity);
  const rank = Math.min(list.length - 1, Math.max(12, Math.floor(list.length * .30)));
  const threshold = Math.max(best - .07, Number(list[rank]?.similarity) || -1);
  const span = Math.max(.012, best - threshold);
  return list.filter(item => Number(item.similarity) >= threshold).map(item => ({
    hash:String(item.hash),
    confidence:Math.max(.55, Math.min(.99, .62 + (Number(item.similarity) - threshold) / span * .34)),
    similarity:Number(item.similarity)
  }));
}

async function semanticCandidates(ai, prompt) {
  const matches = await ai.search(prompt, { limit:AI_LIMIT, onProgress:event => aiProgress(event.detail || 'Semantic AI…') });
  return adaptiveSemanticMatches(matches);
}

async function exampleCandidates(ai, positives, negatives) {
  const examples = positives.slice(0, 5);
  const exampleSet = new Set(examples);
  const positive = new Map();
  const negative = new Map();
  const addPositive = (hash, similarity) => {
    if (!positive.has(hash)) positive.set(hash, []);
    positive.get(hash).push(Number(similarity) || -1);
  };

  for (const [index, hash] of examples.entries()) {
    aiProgress(`Visual examples · ${index + 1} / ${examples.length}`);
    const matches = await ai.similar(hash, 'dinov3', { limit:200, onProgress:event => { if (event.detail) aiProgress(event.detail); } });
    addPositive(hash, 1);
    for (const item of matches || []) addPositive(item.hash, item.similarity);
  }
  for (const [index, hash] of negatives.slice(0, 5).entries()) {
    aiProgress(`Negative examples · ${index + 1} / ${Math.min(5, negatives.length)}`);
    const matches = await ai.similar(hash, 'dinov3', { limit:200, onProgress:event => { if (event.detail) aiProgress(event.detail); } });
    negative.set(hash, 1);
    for (const item of matches || []) negative.set(item.hash, Math.max(negative.get(item.hash) || -1, Number(item.similarity) || -1));
  }

  const out = [];
  const requiredSupport = examples.length > 1 ? 2 : 1;
  for (const [hash, scores] of positive) {
    if (exampleSet.has(hash)) {
      out.push({ hash, confidence:1, similarity:1 });
      continue;
    }
    const ranked = scores.filter(Number.isFinite).sort((a, b) => b - a);
    if (ranked.length < requiredSupport) continue;
    const support = ranked.slice(0, requiredSupport);
    const similarity = support.reduce((sum, value) => sum + value, 0) / support.length;
    if (similarity < .80) continue;
    const negativeSimilarity = negative.get(hash) ?? -1;
    if (negativeSimilarity >= similarity - .015) continue;
    const confidence = Math.max(.55, Math.min(.99, .55 + (similarity - .78) * 2.1 + Math.min(.08, (ranked.length - requiredSupport) * .02)));
    out.push({ hash, confidence, similarity });
  }
  return out;
}

async function applyAiToTag(tag) {
  const state = await loadTagState(tag.id, true);
  const positives = exampleHashes(state, 1);
  const negatives = exampleHashes(state, -1);
  const ai = await ensureAi();
  const merged = new Map();
  const explicitDescription = String(managerEditor.querySelector('[data-edit-tag-description]')?.value || tag.description || '').trim();
  const prompt = explicitDescription || tag.name;
  aiProgress('Preparing AI…');

  if (positives.length) {
    const visual = await exampleCandidates(ai, positives, negatives);
    for (const item of visual) merged.set(item.hash, item);

    // With examples, the examples define the tag. Semantic text may strengthen
    // a visual candidate only when the user explicitly described the meaning;
    // a project/name label by itself must never add unrelated files.
    if (explicitDescription) {
      const semantic = new Map((await semanticCandidates(ai, explicitDescription)).map(item => [item.hash, item]));
      for (const [hash, item] of merged) {
        const semanticMatch = semantic.get(hash);
        if (!semanticMatch) continue;
        merged.set(hash, { ...item, confidence:Math.min(.99, Math.max(item.confidence, semanticMatch.confidence) + .04) });
      }
    }
  } else {
    for (const item of await semanticCandidates(ai, prompt)) merged.set(item.hash, item);
  }

  for (const hash of negatives) merged.delete(hash);
  const matches = [...merged.values()].map(item => ({ hash:item.hash, confidence:item.confidence }));
  aiProgress(`Applying ${matches.length.toLocaleString()} matches…`);
  const result = await json(`/api/tags/${tag.id}/ai-members`, { method:'POST', body:{ matches, source:'ai' } });
  aiProgress(`${Number(result.count || 0).toLocaleString()} AI matches applied`);
  await afterTagMutation();
  setTimeout(() => aiProgress(''), 1800);
}

async function scanSensitive() {
  await refreshTags().catch(() => {});
  const tag = sensitiveTag();
  if (!tag) throw new Error('Sensitive tag is unavailable');
  managerTagId = String(tag.id);
  if (manager.open) { renderManagerList(); await renderManagerEditor(); }
  const ai = await ensureAi();
  const positives = [
    'a sexually explicit pornographic image with visible nudity',
    'a nude person with exposed breasts or genitals',
    'explicit sexual activity or pornography'
  ];
  const negatives = [
    'a normal safe everyday photograph with no nudity or sexual content',
    'a family friendly image with fully clothed people or ordinary non sexual content'
  ];
  const hits = new Map();
  const safe = new Map();
  for (const [index, prompt] of positives.entries()) {
    aiProgress(`Sensitive scan · ${index + 1} / ${positives.length + negatives.length}`);
    const matches = adaptiveSemanticMatches(await ai.search(prompt, { limit:AI_LIMIT, onProgress:event => { if (event.detail) aiProgress(event.detail); } }));
    for (const item of matches) {
      const current = hits.get(item.hash) || { count:0, best:-1 };
      current.count++;
      current.best = Math.max(current.best, item.similarity);
      hits.set(item.hash, current);
    }
  }
  for (const [index, prompt] of negatives.entries()) {
    aiProgress(`Sensitive scan · ${positives.length + index + 1} / ${positives.length + negatives.length}`);
    const matches = await ai.search(prompt, { limit:AI_LIMIT, onProgress:event => { if (event.detail) aiProgress(event.detail); } });
    for (const item of matches || []) safe.set(item.hash, Math.max(safe.get(item.hash) || -1, Number(item.similarity) || -1));
  }
  const matches = [];
  for (const [hash, value] of hits) {
    const safeScore = safe.get(hash) ?? -1;
    const margin = value.best - safeScore;
    if (value.count < 2 || value.best < .16 || margin < .015) continue;
    matches.push({ hash, confidence:Math.max(.58, Math.min(.99, .58 + (value.count - 2) * .12 + margin * 3.2)) });
  }
  aiProgress(`Applying ${matches.length.toLocaleString()} conservative matches…`);
  const result = await json(`/api/tags/${tag.id}/ai-members`, { method:'POST', body:{ matches, source:'system' } });
  sensitiveMode = sensitiveMode || 'hide';
  sensitiveSelect.value = sensitiveMode;
  aiProgress(`${Number(result.count || 0).toLocaleString()} sensitive items marked`);
  await afterTagMutation();
  setTimeout(() => aiProgress(''), 2200);
}

const SUGGESTION_PROMPTS = {
  People:'a photo of people, portraits, selfies, friends or family',
  Pets:'a photo of a pet, dog, cat or other companion animal',
  Food:'a photo of food, a meal, cooking or a restaurant dish',
  Screenshots:'a computer or phone screenshot, software interface or app UI',
  Documents:'a document, receipt, form, page of text, scan or paperwork',
  Nature:'a photo of nature, plants, forests, mountains, water or landscapes',
  Travel:'a travel photo, vacation, landmark, hotel, airport or sightseeing',
  Games:'a video game screenshot, game UI or gameplay',
  Artwork:'an illustration, drawing, painting, digital art or graphic design',
  Memes:'a meme, reaction image, joke image or image macro'
};

async function suggestTags() {
  const ai = await ensureAi();
  aiProgress('Finding useful concepts…');
  const groups = await ai.groups({ limitPerGroup:120, onProgress:event => aiProgress(event.detail || 'Finding tag suggestions…') });
  const existing = new Set(tags.map(tag => tag.name.toLowerCase()));
  suggestions = (groups || []).filter(group => !existing.has(String(group.name).toLowerCase()) && (group.matches || []).length >= 5)
    .map(group => ({ ...group, candidates:adaptiveSemanticMatches(group.matches || []) }));
  renderSuggestions();
  aiProgress(suggestions.length ? `${suggestions.length} suggestions` : 'No new useful suggestions');
}

function renderSuggestions() {
  const target = managerEditor.querySelector('.tag-suggestions');
  if (!target) return;
  target.innerHTML = suggestions.map((item, index) => `<div class="tag-suggestion"><div><strong>${escapeHtml(item.name)}</strong><br><small>${item.candidates.length.toLocaleString()} strong matches</small></div><button type="button" data-create-suggestion="${index}">Create</button></div>`).join('');
}

manager.querySelector('[data-tag-suggest]').addEventListener('click', () => suggestTags().catch(error => aiProgress(error.message)));
managerEditor.addEventListener('click', async event => {
  const tag = tagById(managerTagId);
  if (!tag) return;
  try {
    if (event.target.closest('[data-tag-save]')) {
      const name = managerEditor.querySelector('[data-edit-tag-name]')?.value || tag.name;
      const description = managerEditor.querySelector('[data-edit-tag-description]')?.value || '';
      const aiEnabled = Boolean(managerEditor.querySelector('[data-edit-tag-ai]')?.checked);
      await json(`/api/tags/${tag.id}`, { method:'POST', body:{ name, description, aiEnabled } });
      await afterTagMutation();
      return;
    }
    if (event.target.closest('[data-tag-ai-apply]')) { await applyAiToTag(tag); return; }
    if (event.target.closest('[data-tag-sensitive-scan]')) { await scanSensitive(); return; }
    if (event.target.closest('[data-tag-clear-ai]')) {
      await json(`/api/tags/${tag.id}/ai-members`, { method:'POST', body:{ matches:[], source:String(tag.name).toLowerCase() === 'sensitive' ? 'system' : 'ai' } });
      await afterTagMutation();
      return;
    }
    if (event.target.closest('[data-tag-positive]') || event.target.closest('[data-tag-negative]')) {
      const hashes = selectedHashes();
      if (!hashes.length) { aiProgress('Select files or open one first'); return; }
      const state = await loadTagState(tag.id, true);
      let positive = new Set(exampleHashes(state, 1));
      let negative = new Set(exampleHashes(state, -1));
      const yes = Boolean(event.target.closest('[data-tag-positive]'));
      for (const hash of hashes) {
        if (yes) { positive.add(hash); negative.delete(hash); }
        else { negative.add(hash); positive.delete(hash); }
      }
      await json(`/api/tags/${tag.id}/examples`, { method:'POST', body:{ positive:[...positive], negative:[...negative] } });
      await afterTagMutation();
      return;
    }
    if (event.target.closest('[data-tag-filter-current]')) {
      tagFilterId = String(tag.id);
      tagSelect.value = tagFilterId;
      manager.close();
      scheduleScope();
      return;
    }
    if (event.target.closest('[data-tag-delete]')) {
      if (!confirm(`Delete tag “${tag.name}”?`)) return;
      await json(`/api/tags/${tag.id}`, { method:'DELETE' });
      managerTagId = '';
      await afterTagMutation();
      managerTagId = String(tags[0]?.id || '');
      renderManagerList();
      await renderManagerEditor();
      return;
    }
    const suggestionButton = event.target.closest('[data-create-suggestion]');
    if (suggestionButton) {
      const suggestion = suggestions[Number(suggestionButton.dataset.createSuggestion)];
      if (!suggestion) return;
      const created = await json('/api/tags', { method:'POST', body:{ name:suggestion.name, description:SUGGESTION_PROMPTS[suggestion.name] || suggestion.name, aiEnabled:true } });
      await json(`/api/tags/${created.tag.id}/ai-members`, { method:'POST', body:{ matches:suggestion.candidates.map(item => ({ hash:item.hash, confidence:item.confidence })), source:'ai' } });
      managerTagId = String(created.tag.id);
      suggestions = suggestions.filter(item => item !== suggestion);
      await afterTagMutation();
      renderManagerList();
      await renderManagerEditor();
      renderSuggestions();
    }
  } catch (error) {
    console.error(error);
    aiProgress(error.message || String(error));
  }
});

filterActions.querySelector('[data-manage-tags]').addEventListener('click', () => openManager().catch(console.error));
filterActions.querySelector('[data-scan-sensitive]').addEventListener('click', async () => {
  await openManager(String(sensitiveTag()?.id || ''));
  scanSensitive().catch(error => aiProgress(error.message));
});

window.addEventListener('mochimono:catalog-updated', () => { allHashesCache = null; scheduleScope(20); });
window.addEventListener('mochimono:local-catalog-event', () => { allHashesCache = null; scheduleScope(20); });
window.addEventListener('mochimono:grid-model', scheduleDecorate);

window.mochimonoTags = {
  refresh:() => refreshTags(true),
  tags:() => tags.map(item => ({ ...item })),
  open:openManager,
  picker:openPicker,
  scanSensitive,
  setFilter(id = '') { tagFilterId = String(id || ''); tagSelect.value = tagFilterId; scheduleScope(); },
  sensitiveMode(mode) {
    if (!['hide','blur','show'].includes(mode)) return sensitiveMode;
    sensitiveMode = mode;
    sensitiveSelect.value = mode;
    localStorage.setItem(SENSITIVE_MODE_KEY, mode);
    scheduleScope();
    updateSensitivePresentation();
    return mode;
  }
};

(async () => {
  try {
    await refreshTags();
    const sensitive = sensitiveTag();
    if (sensitive) await loadTagState(sensitive.id);
    updateSensitivePresentation();
    scheduleScope();
    scheduleDecorate();
    renderViewerTags().catch(() => {});
  } catch (error) {
    console.warn('Tags are unavailable until the Mochimono Server is updated/restarted.', error);
  }
})();
