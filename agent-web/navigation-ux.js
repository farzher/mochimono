// Native folder menus remain dismissible; navigation is owned by client-shell.
document.addEventListener('pointerdown', event => {
  for (const menu of document.querySelectorAll('.source-action-menu[open]')) {
    if (!menu.contains(event.target)) menu.open = false;
  }
});
document.addEventListener('click', event => {
  const menu = event.target.closest('.source-action-menu');
  if (menu && event.target.closest('button')) menu.open = false;
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  const menu = document.querySelector('.source-action-menu[open]');
  if (!menu) return;
  menu.open = false;
  menu.querySelector('summary').focus();
  event.preventDefault();
});
