const commandbar = document.querySelector('.commandbar');
const search = document.querySelector('#search');
const fileCount = document.querySelector('#fileCount');
const mediaSizes = document.querySelector('#mediaSizeControl');
const views = document.querySelector('#views');

if (commandbar && search) {
  const controls = [
    [document.querySelector('#source'), 'Origin'],
    [document.querySelector('#collectionFilter'), 'Groups'],
    [document.querySelector('#locationFilter'), 'Where'],
    [document.querySelector('#typeFilter'), 'Type'],
    [document.querySelector('#sort'), 'Sort']
  ].filter(([control]) => control);

  const filterMenu = document.createElement('details');
  filterMenu.className = 'library-filter-menu';
  filterMenu.innerHTML = `
    <summary title="Filters" aria-label="Filters">
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 5.25h13M5.75 10h8.5M8 14.75h4"/></svg>
      <span class="library-filter-count" hidden></span>
    </summary>
    <div class="library-filter-popover"></div>`;

  const filterPopover = filterMenu.querySelector('.library-filter-popover');
  for (const [control, label] of controls) {
    const row = document.createElement('label');
    const text = document.createElement('span');
    text.textContent = label;
    row.append(text, control);
    filterPopover.append(row);
  }
  search.after(filterMenu);

  let sizeMenu = null;
  if (mediaSizes && views) {
    sizeMenu = document.createElement('details');
    sizeMenu.className = 'library-size-menu';
    sizeMenu.innerHTML = `
      <summary title="Preview size" aria-label="Preview size">
        <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="4" y="4" width="12" height="12" rx="1.5"/></svg>
      </summary>
      <div class="library-size-popover"></div>`;
    sizeMenu.querySelector('.library-size-popover').append(mediaSizes);
    views.before(sizeMenu);
    mediaSizes.addEventListener('click', event => {
      if (event.target.closest('[data-media-size]')) sizeMenu.open = false;
    });
  }

  const selectionBar = document.querySelector('#selectionBar');
  const selectAll = document.querySelector('#selectAll');
  const selectionGroup = document.querySelector('#selectionCollection');
  const selectionDelete = document.querySelector('#selectionDelete');
  const selectionIgnore = document.querySelector('#selectionIgnore');
  const selectionClear = document.querySelector('#selectionClear');
  let selectionMore = null;

  if (selectionBar && selectionIgnore) {
    selectionMore = document.createElement('details');
    selectionMore.className = 'selection-more';
    selectionMore.innerHTML = '<summary title="More" aria-label="More selection actions">•••</summary><div class="selection-more-popover"></div>';
    selectionMore.querySelector('.selection-more-popover').append(selectionIgnore);
    selectionClear?.before(selectionMore);
    selectionIgnore.textContent = 'Delete + Ignore';
    selectionIgnore.title = 'Delete selected files and ignore them in future scans';
  }

  const style = document.createElement('style');
  style.textContent = `
    .commandbar{gap:5px;padding:6px;border-radius:14px}
    .commandbar .search{min-height:36px;border-radius:9px;padding-left:12px}
    .library-filter-menu,.library-size-menu{position:relative;flex:0 0 auto}
    .library-filter-menu>summary,.library-size-menu>summary{position:relative;width:36px;height:36px;display:grid;place-items:center;padding:0;border-radius:9px;color:#8d8583;cursor:pointer;list-style:none}
    .library-filter-menu>summary::-webkit-details-marker,.library-size-menu>summary::-webkit-details-marker{display:none}
    .library-filter-menu>summary:hover,.library-filter-menu[open]>summary,.library-size-menu>summary:hover,.library-size-menu[open]>summary{background:#2a262b;color:#fff}
    .library-filter-menu>summary svg,.library-size-menu>summary svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
    .library-filter-count{position:absolute;right:2px;top:2px;min-width:14px;height:14px;display:grid;place-items:center;padding:0 3px;border-radius:999px;background:#efa09a;color:#251719;font-size:8px;font-weight:850;line-height:1}
    .library-filter-popover,.library-size-popover{position:absolute;z-index:30;top:42px;right:0;padding:8px;border:1px solid #302b30;border-radius:12px;background:#171518;box-shadow:0 18px 50px rgba(0,0,0,.5)}
    .library-filter-popover{width:250px;display:grid;gap:4px}
    .library-filter-popover label{display:grid;grid-template-columns:58px minmax(0,1fr);align-items:center;gap:8px;padding:3px 4px 3px 8px;color:#827a78;font-size:10px;font-weight:650}
    .library-filter-popover select{width:100%!important;max-width:none!important;height:34px;padding:7px 28px 7px 9px;border-radius:8px;background:#111013;font-size:11px}
    .library-filter-popover select:focus{background:#211e22}
    .library-size-popover{width:max-content}
    .library-size-popover .media-sizes{height:34px;background:#111013}
    .commandbar>.file-count[hidden]{display:none!important}
    .commandbar>.file-count{margin-left:2px;margin-right:auto}
    .commandbar>.library-size-menu{margin-left:auto}
    .commandbar>.file-count:not([hidden])~.library-size-menu{margin-left:0}
    .commandbar>.views{flex:0 0 auto}
    .collection-strip button:not(.active):not(.save-view){display:none}

    .selection-bar{left:auto!important;right:0!important;width:max-content!important;max-width:min(100%,620px)!important;gap:2px!important;min-height:38px!important;padding:4px 5px!important;border-radius:10px!important}
    .selection-bar strong{padding:0 7px;font-size:10px!important}
    .selection-bar>button,.selection-more>summary{width:30px;height:30px;display:grid!important;place-items:center;padding:0!important;border-radius:7px!important;color:#aaa19e!important;font-size:0!important;list-style:none;cursor:pointer}
    .selection-bar>button:hover,.selection-more>summary:hover,.selection-more[open]>summary{background:#2a262b!important;color:#fff!important}
    .selection-more>summary::-webkit-details-marker{display:none}
    #selectAll:before{content:'✓';font-size:13px;font-weight:800}
    #selectionCollection:before{content:'+';font-size:19px;font-weight:400;line-height:1}
    #selectionDelete:before{content:'⌫';font-size:17px;font-weight:500;line-height:1}
    #selectionClear:before{content:'×';font-size:20px;font-weight:400;line-height:1}
    .selection-more{position:relative;flex:0 0 auto}
    .selection-more>summary{font-size:14px!important;font-weight:800;letter-spacing:1px}
    .selection-more-popover{position:absolute;z-index:40;right:0;top:34px;width:145px;padding:5px;border:1px solid #302b30;border-radius:10px;background:#171518;box-shadow:0 14px 40px rgba(0,0,0,.48)}
    .selection-more-popover #selectionIgnore{display:block!important;width:100%!important;height:32px!important;padding:0 9px!important;border-radius:7px!important;background:transparent!important;color:#d69a94!important;font-size:10px!important;text-align:left!important}
    .selection-more-popover #selectionIgnore:hover{background:#2a262b!important;color:#f0aaa3!important}

    @media(max-width:840px){
      .commandbar{flex-wrap:nowrap;top:5px}
      .commandbar .search{flex:1 1 auto;min-width:0}
      .commandbar>.file-count{display:none!important}
      .library-filter-popover{position:fixed;left:10px;right:10px;top:58px;width:auto}
      .library-filter-popover label{grid-template-columns:54px minmax(0,1fr)}
      .views button{width:29px}
      .selection-bar{max-width:calc(100vw - 20px)!important}
    }
    @media(max-width:520px){
      .commandbar{gap:3px;padding:5px}
      .library-filter-menu>summary,.library-size-menu>summary{width:32px;height:34px}
      .views{padding:2px}.views button{width:28px;height:30px}
      .library-size-popover{right:-66px}
      .selection-bar strong{padding:0 4px}
      .selection-bar>button,.selection-more>summary{width:28px}
    }
  `;
  document.head.append(style);

  selectAll?.setAttribute('title', 'Select all');
  selectAll?.setAttribute('aria-label', 'Select all');
  selectionGroup?.setAttribute('title', 'Add to group');
  selectionGroup?.setAttribute('aria-label', 'Add to group');
  selectionDelete?.setAttribute('title', 'Delete');
  selectionDelete?.setAttribute('aria-label', 'Delete selected files');
  selectionClear?.setAttribute('title', 'Clear selection');

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
    const badge = filterMenu.querySelector('.library-filter-count');
    badge.hidden = !count;
    badge.textContent = count || '';
    filterMenu.querySelector('summary').title = count ? `Filters · ${count} active` : 'Filters';
    const searching = Boolean(search.value.trim());
    if (fileCount) fileCount.hidden = !searching && !count;
    if (sizeMenu && mediaSizes) {
      sizeMenu.hidden = mediaSizes.hidden;
      if (sizeMenu.hidden) sizeMenu.open = false;
    }
  }

  for (const [control] of controls) control.addEventListener('change', sync);
  search.addEventListener('input', sync);
  if (mediaSizes) new MutationObserver(sync).observe(mediaSizes, { attributes: true, attributeFilter: ['hidden'] });
  sync();

  const menus = [filterMenu, sizeMenu, selectionMore].filter(Boolean);
  document.addEventListener('pointerdown', event => {
    for (const menu of menus) if (menu.open && !menu.contains(event.target)) menu.open = false;
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const open = menus.find(menu => menu.open);
    if (!open) return;
    open.open = false;
    open.querySelector('summary')?.focus();
  }, true);
}
