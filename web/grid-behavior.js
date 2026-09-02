const files = document.querySelector('#files');

if (files) {
  const style = document.createElement('style');
  style.textContent = `
    .files.grid .day-group-control,
    .files.grid .day-group-control:hover,
    .files.grid .day-group-control:focus-visible{
      padding:0 6px!important;
      border:0!important;
      border-radius:0!important;
      background:transparent!important;
      box-shadow:none!important;
    }
  `;
  document.head.append(style);
}
