const compare = document.querySelector('.video-optimize-compare');

if (compare) {
  const style = document.createElement('style');
  style.textContent = `
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
  .video-optimize-divider-handle{
    width:38px!important;
    height:38px!important;
  }
}
`;
  document.head.append(style);
}
