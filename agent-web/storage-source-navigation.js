const folders = document.querySelector('#folders');
const frame = document.querySelector('#filesFrame');
const storagePane = document.querySelector('#storagePane');
const storageButton = document.querySelector('[data-client-tab="storage"]');
const toastNode = document.querySelector('#toast');

if (folders && frame && storagePane) {
  const pathKey = value => String(value || '').trim().replace(/[\\/]+$/, '').toLowerCase();

  function toast(text) {
    if (!toastNode) return;
    toastNode.textContent = text;
    toastNode.classList.add('show');
    clearTimeout(toastNode.timer);
    toastNode.timer = setTimeout(() => toastNode.classList.remove('show'), 2800);
  }

  async function request(path) {
    const response = await fetch(path, { cache:'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || response.statusText);
    return data;
  }

  function decorate(root = folders) {
    const openButtons = root.matches?.('[data-open-native-folder]')
      ? [root]
      : [...root.querySelectorAll?.('[data-open-native-folder]') || []];
    for (const button of openButtons) button.remove();

    const previews = root.matches?.('.storage-folder-samples')
      ? [root]
      : [...root.querySelectorAll?.('.storage-folder-samples') || []];
    for (const preview of previews) {
      preview.removeAttribute('data-open-native-folder-path');
      preview.dataset.openLibraryFolder = '';
      preview.title = 'Open in Mochimono';
    }
  }

  async function openLibraryFolder(path) {
    const state = await request('/api/state');
    const folder = (state.settings?.folders || []).find(item => pathKey(item.path) === pathKey(path));
    const importId = Number(folder?.importId) || 0;
    if (!importId) throw new Error('This folder is not indexed yet.');

    const child = frame.contentWindow;
    const library = child?.mochimonoLibrary;
    if (!library?.openFolder) throw new Error('Library is still loading.');

    child.mochimonoHome?.('replace');
    const gridButton = frame.contentDocument?.querySelector('#views [data-view="grid"]');
    if (gridButton && !gridButton.classList.contains('active')) gridButton.click();

    await library.openFolder(importId, '');
    child.scrollTo({ top:0, left:0, behavior:'auto' });
    if (!storagePane.hidden) storageButton?.click();
    child.focus();
  }

  folders.addEventListener('click', event => {
    const preview = event.target.closest('[data-open-library-folder]');
    if (!preview) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const path = preview.closest('[data-folder-path]')?.dataset.folderPath || '';
    if (!path) return;
    openLibraryFolder(path).catch(error => toast(error.message));
  }, true);

  new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes') decorate(record.target);
      else for (const node of record.addedNodes) if (node instanceof Element) decorate(node);
    }
  }).observe(folders, {
    childList:true,
    subtree:true,
    attributes:true,
    attributeFilter:['data-open-native-folder-path']
  });

  decorate();
}
