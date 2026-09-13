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

const style = document.createElement('style');
style.textContent = `
.command-tags{height:32px;min-width:46px;padding:0 9px;border:0;border-radius:8px;background:transparent;color:#a79e9a;font:700 10.5px/1 system-ui;cursor:pointer;flex:0 0 auto}.command-tags:hover,.command-tags:focus-visible{outline:0;background:#272328;color:#eee8e4}.command-tags.active{background:#eee8e4;color:#171416}
.viewer-action.viewer-tag-action{border:0;font:700 11px/1 system-ui;cursor:pointer}.viewer-action.viewer-tag-action[data-count]:not([data-count="0"]){color:#eee8e4}
.tag-quick-help{padding:9px 10px;border:1px solid rgba(255,255,255,.075);border-radius:9px;background:#111012;color:#928986;font:10.5px/1.5 system-ui}.tag-quick-help strong{color:#d8cfcb;font-weight:750}.tag-editor-toggle.tag-advanced-hidden{display:none!important}
.file-context-action[data-tag-context]{order:-1}
`;
document.head.append(style);

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

async function tagCount(hash) {
  if (!hash) return 0;
  try {
    const response = await fetch(`/api/tags/file/${encodeURIComponent(hash)}`, { cache:'no-store' });
    if (!response.ok) return 0;
    return Number((await response.json()).tags?.length) || 0;
  } catch { return 0; }
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
  // The context menu focuses its button on click, so remember the focused media
  // card on pointer-down while it is still the active element.
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

function polishManager() {
  if (!managerEditor) return;
  const fields = managerEditor.querySelector('.tag-editor-fields');
  if (!fields || fields.dataset.simpleTags === '1') return;
  fields.dataset.simpleTags = '1';

  const help = document.createElement('div');
  help.className = 'tag-quick-help';
  help.innerHTML = '<strong>Manual:</strong> open or right-click media → Tag. &nbsp; <strong>AI:</strong> describe what belongs here → Find matching media.';
  fields.prepend(help);

  for (const span of fields.querySelectorAll('label > span')) {
    if (span.textContent.trim() === 'AI meaning') span.textContent = 'What belongs in this tag?';
  }
  const description = fields.querySelector('[data-edit-tag-description]');
  if (description) description.placeholder = 'Example: photos of my cat, screenshots of code, Gudetama…';

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

if (manager) {
  const newInput = manager.querySelector('[data-tag-new]');
  if (newInput) newInput.placeholder = 'Create a tag…';
  const create = manager.querySelector('[data-tag-new-create]');
  if (create) { create.title = 'Create tag'; create.setAttribute('aria-label', 'Create tag'); }
  new MutationObserver(polishManager).observe(managerEditor, { childList:true, subtree:true });
  polishManager();
}
