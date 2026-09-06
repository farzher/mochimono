const compare = document.querySelector('.video-optimize-compare');

if (compare) {
  const style = document.createElement('style');
  style.textContent = `
.video-optimize-layer{z-index:102!important}
.video-optimize-label{top:70px!important}
.viewer.video-optimize-active .viewer-bar,
.viewer.video-optimize-active .viewer-collections{opacity:1!important;pointer-events:auto!important}
.viewer.video-optimize-active .viewer-bar *,
.viewer.video-optimize-active .viewer-collections *{pointer-events:auto!important}
.video-optimize-divider:before{
  width:4px!important;
  background:rgba(0,0,0,.62)!important;
  box-shadow:0 0 0 1px rgba(255,255,255,.04)!important;
}
.video-optimize-divider-handle{
  width:42px!important;
  height:42px!important;
  border-radius:50%!important;
  gap:3px!important;
}
@media(max-width:760px){
  .video-optimize-label{top:60px!important}
  .video-optimize-divider-handle{
    width:38px!important;
    height:38px!important;
  }
}
`;
  document.head.append(style);
}
