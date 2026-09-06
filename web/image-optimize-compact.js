const controls = [...document.querySelectorAll('.image-optimize-controls')];

if (controls.length) {
  const style = document.createElement('style');
  style.textContent = `
.image-optimize-controls .image-optimize-tuning{
  gap:6px!important;
  margin-top:7px!important;
  padding:8px!important;
}
.image-optimize-range-inline{
  display:grid!important;
  grid-template-columns:auto minmax(70px,1fr) auto!important;
  align-items:center!important;
  gap:8px!important;
}
.image-optimize-range-inline>.image-optimize-inline-label{
  color:#d6cfcb;
  font-size:11px;
  font-weight:700;
  white-space:nowrap;
}
.image-optimize-range-inline>output{
  min-width:38px;
  color:#aaa29e;
  font-size:11px;
  font-weight:700;
  text-align:right;
  white-space:nowrap;
  font-variant-numeric:tabular-nums;
}
.image-optimize-range-inline>input[type=range]{min-width:0;width:100%;margin:0;accent-color:#eee9e5}
.image-optimize-controls .image-optimize-segmented{
  gap:8px!important;
}
.image-optimize-controls .image-optimize-segmented .image-optimize-choice-grid{
  width:auto!important;
  min-width:0;
}
.image-optimize-controls .image-optimize-segmented:not(.effort){
  grid-template-columns:auto minmax(0,1fr)!important;
}
.image-optimize-controls .image-optimize-segmented.effort.image-optimize-range-inline{
  grid-template-columns:auto minmax(70px,1fr) auto!important;
}
.image-optimize-controls .image-optimize-quick{
  margin-top:8px!important;
}
.image-optimize-controls .image-optimize-actions{
  margin-top:7px!important;
}
@media(max-width:760px){
  .image-optimize-controls .image-optimize-tuning{padding:7px!important}
  .image-optimize-range-inline,
  .image-optimize-controls .image-optimize-segmented.effort.image-optimize-range-inline{
    grid-template-columns:auto minmax(45px,1fr) auto!important;
    gap:6px!important;
  }
}
`;
  document.head.append(style);

  function compactSlider(row) {
    if (!row || row.classList.contains('image-optimize-range-inline')) return;
    const head = row.querySelector(':scope > .image-optimize-tune-head');
    const title = head?.querySelector('span');
    const output = head?.querySelector('output');
    const input = row.querySelector(':scope > input[type=range]');
    if (!head || !title || !output || !input) return;
    title.classList.add('image-optimize-inline-label');
    row.classList.add('image-optimize-range-inline');
    row.append(title, input, output);
    head.remove();
  }

  function compactEffort(control) {
    const row = control.querySelector('.image-optimize-segmented.effort');
    const wrapper = row?.querySelector('.image-optimize-effort-control');
    const title = row?.querySelector(':scope > .image-optimize-tune-head');
    const input = wrapper?.querySelector('input[type=range]');
    const output = wrapper?.querySelector('output');
    if (!row || !wrapper || !title || !input || !output) return;
    title.classList.add('image-optimize-inline-label');
    row.classList.add('image-optimize-range-inline');
    row.append(title, input, output);
    wrapper.remove();
  }

  for (const control of controls) {
    compactSlider(control.querySelector('.image-optimize-slider:has([data-opt-max-size])'));
    compactSlider(control.querySelector('.image-optimize-slider:has([data-opt-quality])'));
    compactEffort(control);
  }
}
