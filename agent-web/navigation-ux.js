import './storage-source-controls.js';

const actions = document.querySelector('.client-head-actions');
const storagePane = document.querySelector('#storagePane');
const storageToggle = document.querySelector('[data-client-tab="storage"]');

if (actions && storagePane && storageToggle) {
  const style = document.createElement('style');
  style.textContent = `
    .primary-nav{display:flex;align-items:center;gap:2px;padding:2px;border:1px solid #292529;border-radius:9px;background:#141215}
    .primary-nav button{height:27px;padding:0 10px;border:0;border-radius:6px;background:transparent;color:#817a79;font-size:10px;font-weight:700;cursor:pointer}
    .primary-nav button:hover{color:#ddd4d0;background:#211e22}
    .primary-nav button.active{color:#f0e8e4;background:#29252a}
    .client-menu [data-client-tab="storage"]{display:none!important}
    @media(max-width:700px){.primary-nav button{padding:0 8px}.primary-nav{gap:0}}
  `;
  document.head.append(style);

  const nav = document.createElement('nav');
  nav.className = 'primary-nav';
  nav.setAttribute('aria-label', 'Mochimono view');
  nav.innerHTML = `
    <button type="button" data-primary-view="library">Library</button>
    <button type="button" data-primary-view="storage">Storage</button>`;
  actions.insertBefore(nav, actions.firstChild);

  const libraryButton = nav.querySelector('[data-primary-view="library"]');
  const storageButton = nav.querySelector('[data-primary-view="storage"]');

  function sync() {
    const storage = !storagePane.hidden;
    libraryButton.classList.toggle('active', !storage);
    storageButton.classList.toggle('active', storage);
    libraryButton.setAttribute('aria-current', storage ? 'false' : 'page');
    storageButton.setAttribute('aria-current', storage ? 'page' : 'false');
  }

  libraryButton.onclick = () => {
    if (!storagePane.hidden) storageToggle.click();
    sync();
  };
  storageButton.onclick = () => {
    if (storagePane.hidden) storageToggle.click();
    sync();
  };

  new MutationObserver(sync).observe(storagePane, { attributes:true, attributeFilter:['hidden'] });
  addEventListener('popstate', () => queueMicrotask(sync));
  sync();
}
