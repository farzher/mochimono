const root=document.documentElement;
const style=document.createElement('style');
style.textContent=`
html.experimental-view-active,html.experimental-view-active body{overflow:hidden!important}
html.experimental-view-active .shell{visibility:visible!important}
html.experimental-view-active .shell>#app{visibility:hidden!important}
html.experimental-view-active .experimental-view-surface{
  position:fixed!important;
  top:var(--experimental-surface-top,140px)!important;
  right:0!important;
  bottom:0!important;
  left:0!important;
  width:100vw!important;
  height:auto!important;
  min-height:0!important;
  margin:0!important;
  border:0!important;
  border-radius:0!important;
  visibility:visible!important;
  z-index:20
}
html.experimental-view-active .experimental-view-bar{
  position:fixed!important;
  top:var(--experimental-bar-top,90px)!important;
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

let bar=null,surface=null,topbar=null;
function syncGeometry(){
  if(!root.classList.contains('experimental-view-active')||!bar||!topbar)return;
  const topRect=topbar.getBoundingClientRect();
  const topStyle=getComputedStyle(topbar);
  const barTop=Math.ceil(topRect.bottom+(parseFloat(topStyle.marginBottom)||0));
  root.style.setProperty('--experimental-bar-top',`${barTop}px`);
  requestAnimationFrame(()=>{
    if(!root.classList.contains('experimental-view-active')||!bar)return;
    root.style.setProperty('--experimental-surface-top',`${Math.ceil(barTop+bar.getBoundingClientRect().height+6)}px`);
  });
}
function detachExperimentalChrome(){
  bar=document.querySelector('.experimental-view-bar');
  surface=document.querySelector('.experimental-view-surface');
  topbar=document.querySelector('.topbar');
  if(!bar||!surface||!topbar)return false;
  if(bar.parentElement!==document.body)document.body.append(bar);
  if(surface.parentElement!==document.body)document.body.append(surface);
  syncGeometry();
  return true;
}

const mountObserver=new MutationObserver(()=>{
  if(detachExperimentalChrome())mountObserver.disconnect();
});
if(!detachExperimentalChrome())mountObserver.observe(document.body,{childList:true,subtree:true});

new MutationObserver(syncGeometry).observe(root,{attributes:true,attributeFilter:['class']});
window.addEventListener('resize',syncGeometry,{passive:true});
if(globalThis.ResizeObserver){
  const resizeObserver=new ResizeObserver(syncGeometry);
  const watch=()=>{
    if(!detachExperimentalChrome())return requestAnimationFrame(watch);
    resizeObserver.observe(topbar);
    resizeObserver.observe(bar);
  };
  watch();
}
queueMicrotask(detachExperimentalChrome);
