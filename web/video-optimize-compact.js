const controls = document.querySelector('[data-controls]');

if (controls) {
  const style = document.createElement('style');
  style.textContent = `
.video-optimize-card-right>.video-optimize-section{
  margin-top:7px!important;
  padding:8px!important;
  gap:6px!important;
}
.video-optimize-range-inline{
  display:grid!important;
  grid-template-columns:auto minmax(70px,1fr) auto!important;
  align-items:center!important;
  gap:8px!important;
}
.video-optimize-range-inline>.video-optimize-inline-label{
  color:#d6cfcb;
  font-size:11px;
  font-weight:700;
  white-space:nowrap;
}
.video-optimize-range-inline>output{
  min-width:38px;
  color:#aaa29e;
  font-size:11px;
  font-weight:700;
  text-align:right;
  white-space:nowrap;
  font-variant-numeric:tabular-nums;
}
.video-optimize-range-inline>input[type=range]{min-width:0}
.video-optimize-bitrate.video-optimize-range-inline{
  grid-template-columns:auto 82px minmax(64px,1fr) auto!important;
}
.video-optimize-bitrate-choices{
  gap:3px!important;
}
.video-optimize-bitrate-choices .video-optimize-choice{
  min-height:26px!important;
  padding:0 4px!important;
  font-size:9.5px!important;
}
.video-optimize-bitrate.video-optimize-range-inline>output{min-width:64px}
@media(max-width:760px){
  .video-optimize-card-right>.video-optimize-section{padding:7px!important}
  .video-optimize-range-inline{grid-template-columns:auto minmax(45px,1fr) auto!important;gap:6px!important}
  .video-optimize-bitrate.video-optimize-range-inline{
    grid-template-columns:auto minmax(45px,1fr) auto!important;
  }
  .video-optimize-bitrate-choices{
    grid-column:1/-1;
    grid-row:2;
  }
  .video-optimize-bitrate.video-optimize-range-inline>input[type=range]{grid-column:2}
}
`;
  document.head.append(style);

  function compactRange(slider) {
    const section = slider?.closest('.video-optimize-section');
    const head = section?.querySelector(':scope > .video-optimize-head');
    const title = head?.querySelector('span');
    const output = head?.querySelector('output');
    if (!section || !head || !title || !output) return;

    title.classList.add('video-optimize-inline-label');
    section.classList.add('video-optimize-range-inline');
    section.append(title, slider, output);
    head.remove();
  }

  compactRange(controls.querySelector('[data-q]'));
  compactRange(controls.querySelector('[data-e]'));

  const sample = controls.querySelector('[data-s]');
  sample?.closest('.video-optimize-section')?.querySelector('.video-optimize-note')?.remove();
  compactRange(sample);

  const bitrate = controls.querySelector('.video-optimize-bitrate');
  if (bitrate) {
    const head = bitrate.querySelector(':scope > .video-optimize-head');
    const title = head?.querySelector('span');
    const output = head?.querySelector('output');
    const choices = bitrate.querySelector('.video-optimize-bitrate-choices');
    const slider = bitrate.querySelector('[data-video-bitrate]');
    if (head && title && output && choices && slider) {
      title.classList.add('video-optimize-inline-label');
      bitrate.classList.add('video-optimize-range-inline');
      bitrate.append(title, choices, slider, output);
      head.remove();
    }
  }
}
