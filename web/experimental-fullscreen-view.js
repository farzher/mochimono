const style=document.createElement('style');
style.textContent=`
html.experimental-view-active,html.experimental-view-active body{overflow:hidden!important}
html.experimental-view-active .shell{visibility:hidden!important}
html.experimental-view-active .experimental-view-surface{
  position:fixed!important;
  inset:0!important;
  width:100vw!important;
  height:100dvh!important;
  min-height:0!important;
  margin:0!important;
  border:0!important;
  border-radius:0!important;
  visibility:visible!important;
  z-index:20
}
html.experimental-view-active .experimental-view-bar{
  position:fixed!important;
  top:10px!important;
  left:50%!important;
  width:min(1320px,calc(100vw - 36px))!important;
  max-width:none!important;
  margin:0!important;
  transform:translateX(-50%);
  visibility:visible!important;
  z-index:30
}
@media(max-width:840px){
  html.experimental-view-active .experimental-view-bar{width:calc(100vw - 20px)!important}
}
`;
document.head.append(style);

function detachExperimentalChrome(){
  const bar=document.querySelector('.experimental-view-bar');
  const surface=document.querySelector('.experimental-view-surface');
  if(!bar||!surface)return false;
  if(bar.parentElement!==document.body)document.body.append(bar);
  if(surface.parentElement!==document.body)document.body.append(surface);
  return true;
}

if(!detachExperimentalChrome()){
  const observer=new MutationObserver(()=>{
    if(detachExperimentalChrome())observer.disconnect();
  });
  observer.observe(document.body,{childList:true,subtree:true});
}
queueMicrotask(detachExperimentalChrome);
