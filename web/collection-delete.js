const strip = document.querySelector('#collectionStrip');
const filter = document.querySelector('#collectionFilter');
const RECENT_KEY = 'mochimono-recent-collections';

if (strip && filter) {
  const style = document.createElement('style');
  style.textContent = `
    .collection-strip .delete-active-collection{
      width:27px;
      padding:0;
      margin-left:-3px;
      border-radius:999px;
      color:#817878;
      font-size:16px;
      font-weight:500;
    }
    .collection-strip .delete-active-collection:hover{background:#362527;color:#ffaaa3}
  `;
  document.head.append(style);

  function activeButton() {
    return strip.querySelector('button.active[data-recent-collection]');
  }

  function syncDeleteButton() {
    const active = activeButton();
    const existing = strip.querySelector('[data-delete-active-collection]');
    if (!active) {
      existing?.remove();
      return;
    }
    const key = active.dataset.recentCollection;
    if (existing?.dataset.collectionKey === key) return;
    existing?.remove();
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'delete-active-collection';
    button.dataset.deleteActiveCollection = '';
    button.dataset.collectionKey = key;
    button.setAttribute('aria-label', `Delete ${active.textContent.trim()}`);
    button.title = 'Delete collection';
    button.textContent = '×';
    active.after(button);
  }

  function forgetRecent(key) {
    try {
      const recent = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
      localStorage.setItem(RECENT_KEY, JSON.stringify((Array.isArray(recent) ? recent : []).map(String).filter(item => item !== String(key))));
    } catch {}
  }

  async function removeCollection(button) {
    const key = String(button.dataset.collectionKey || '');
    const active = activeButton();
    if (!key || !active) return;
    const name = active.textContent.trim();
    if (!confirm(`Delete collection “${name}”?\n\nThe files themselves will not be deleted.`)) return;

    const smart = /^s\d+$/.test(key);
    const id = smart ? key.slice(1) : key;
    const path = smart ? `/api/smart-collections/${encodeURIComponent(id)}` : `/api/collections/${encodeURIComponent(id)}`;
    const response = await fetch(path, { method: 'DELETE' });
    if (!response.ok) {
      let message = `${response.status} ${response.statusText}`;
      try { message = (await response.json()).error || message; } catch {}
      throw new Error(message);
    }

    forgetRecent(key);
    const url = new URL(location.href);
    url.searchParams.delete('collection');
    location.replace(url);
  }

  strip.addEventListener('click', event => {
    const button = event.target.closest('[data-delete-active-collection]');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    removeCollection(button).catch(error => alert(error.message));
  });

  new MutationObserver(syncDeleteButton).observe(strip, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class']
  });
  syncDeleteButton();
}
