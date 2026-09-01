const commandbar = document.querySelector('.commandbar');
const search = document.querySelector('#search');
const fileCount = document.querySelector('#fileCount');
const mediaSizes = document.querySelector('#mediaSizeControl');

if (commandbar && search) {
  const controls = [
    [document.querySelector('#source'), 'Origin'],
    [document.querySelector('#collectionFilter'), 'Groups'],
    [document.querySelector('#locationFilter'), 'Where'],
    [document.querySelector('#typeFilter'), 'Type'],
    [document.querySelector('#sort'), 'Sort']
  ].filter(([control]) => control);

  const menu = document.createElement('details');
  menu.className = 'library-filter-menu';
  menu.innerHTML = `
    <summary title="Filters" aria-label="Filters">
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 5.25h13M5.75 10h8.5M8 14.75h4"/></svg>
      <span class="library-filter-count" hidden></span>
    </summary>
    <div class="library-filter-popover"></div>`;

  const popover = menu.querySelector('.library-filter-popover');
  for (const [control, label] of controls) {
    const row = document.createElement('label');
    const text = document.createElement('span');
    text.textContent = label;
    row.append(text, control);
    popover.append(row);
  }
  search.after(menu);

  const style = document.createElement('style');
  style.textContent = `
    .commandbar{gap:5px;padding:6px;border-radius:14px}
    .commandbar .search{min-height:36px;border-radius:9px;padding-left:12px}
    .library-filter-menu{position:relative;flex:0 0 auto}
    .library-filter-menu>summary{position:relative;width:36px;height:36px;display:grid;place-items:center;padding:0;border-radius:9px;color:#8d8583;cursor:pointer;list-style:none}
    .library-filter-menu>summary::-webkit-details-marker{display:none}
    .library-filter-menu>summary:hover,.library-filter-menu[open]>summary{background:#2a262b;color:#fff}
    .library-filter-menu>summary svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round}
    .library-filter-count{position:absolute;right:2px;top:2px;min-width:14px;height:14px;display:grid;place-items:center;padding:0 3px;border-radius:999px;background:#efa09a;color:#251719;font-size:8px;font-weight:850;line-height:1}
    .library-filter-popover{position:absolute;z-index:30;top:42px;right:0;width:250px;display:grid;gap:4px;padding:8px;border:1px solid #302b30;border-radius:12px;background:#171518;box-shadow:0 18px 50px rgba(0,0,0,.5)}
    .library-filter-popover label{display:grid;grid-template-columns:58px minmax(0,1fr);align-items:center;gap:8px;padding:3px 4px 3px 8px;color:#827a78;font-size:10px;font-weight:650}
    .library-filter-popover select{width:100%!important;max-width:none!important;height:34px;padding:7px 28px 7px 9px;border-radius:8px;background:#111013;font-size:11px}
    .library-filter-popover select:focus{background:#211e22}
    .commandbar>.file-count[hidden]{display:none!important}
    .commandbar>.file-count{margin-left:2px;margin-right:auto}
    .commandbar>.media-sizes,.commandbar>.views{flex:0 0 auto}
    @media(min-width:841px){
      .commandbar>.media-sizes{margin-left:auto}
      .commandbar>.file-count:not([hidden])+.media-sizes{margin-left:0}
    }
    @media(max-width:840px){
      .commandbar{flex-wrap:nowrap;top:5px}
      .commandbar .search{flex:1 1 auto;min-width:0}
      .commandbar>.file-count{display:none!important}
      .library-filter-popover{position:fixed;left:10px;right:10px;top:58px;width:auto}
      .library-filter-popover label{grid-template-columns:54px minmax(0,1fr)}
      .media-sizes button{width:28px}.views button{width:29px}
    }
    @media(max-width:560px){
      .media-sizes button:not(.active){display:none}
      .media-sizes{padding:2px}
      .views button{width:30px}
    }
  `;
  document.head.append(style);

  function activeCount() {
    let count = 0;
    for (const [control] of controls) {
      if (control.id === 'sort') {
        if (control.value && control.value !== 'date-desc') count++;
      } else if (control.value) count++;
    }
    return count;
  }

  function sync() {
    const count = activeCount();
    const badge = menu.querySelector('.library-filter-count');
    badge.hidden = !count;
    badge.textContent = count || '';
    menu.querySelector('summary').title = count ? `Filters · ${count} active` : 'Filters';
    const searching = Boolean(search.value.trim());
    if (fileCount) fileCount.hidden = !searching && !count;
  }

  for (const [control] of controls) control.addEventListener('change', sync);
  search.addEventListener('input', sync);
  sync();

  document.addEventListener('pointerdown', event => {
    if (menu.open && !menu.contains(event.target)) menu.open = false;
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && menu.open) {
      menu.open = false;
      menu.querySelector('summary')?.focus();
    }
  }, true);
}
