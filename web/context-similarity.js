const files = document.querySelector('#files');
const menu = document.querySelector('.file-context-menu');
const actions = menu?.querySelector('.file-context-actions');

if (files && menu && actions) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'file-context-action';
  button.dataset.contextSimilarity = '';
  button.hidden = true;
  button.innerHTML = `<i><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.2" cy="8.2" r="4.3"/><path d="m11.4 11.4 4.1 4.1M5.5 8.2h5.4M8.2 5.5v5.4"/></svg></i><span>Find similar</span>`;
  actions.prepend(button);

  let hash = '';
  let name = '';

  files.addEventListener('contextmenu', event => {
    const card = event.target.closest('.file-card.media-card[data-hash]');
    if (!card || !files.contains(card)) {
      hash = '';
      name = '';
      button.hidden = true;
      return;
    }
    const image = !card.classList.contains('video-card');
    hash = image ? String(card.dataset.hash || '') : '';
    name = image ? String(card.dataset.filename || card.title || '') : '';
    button.hidden = !hash;
  }, true);

  menu.addEventListener('click', event => {
    if (!event.target.closest('[data-context-similarity]') || !hash) return;
    const selectedHash = hash;
    const selectedName = name;
    event.preventDefault();
    event.stopImmediatePropagation();
    menu.querySelector('[data-context-action="close"]')?.click();
    queueMicrotask(() => window.mochimonoVisualSimilarity?.find?.(selectedHash, selectedName));
  }, true);
}
