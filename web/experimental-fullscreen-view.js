const root=document.documentElement;
const style=document.createElement('style');
style.textContent=`
html.experimental-view-active,html.experimental-view-active body{overflow:hidden!important}
html.experimental-view-active .shell{visibility:visible!important}
html.experimental-view-active .shell>#app{visibility:hidden!important}
html.experimental-view-active .topbar{position:relative!important;z-index:40!important}
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
  z-index:10
}
html.experimental-view-active .experimental-view-bar{
  position:fixed!important;
  top:var(--experimental-bar-top,90px)!important;
  left:var(--experimental-bar-left,18px)!important;
  width:var(--experimental-bar-width,calc(100vw - 36px))!important;
  max-width:none!important;
  margin:0!important;
  transform:none!important;
  visibility:visible!important;
  z-index:50
}
.experimental-view-loading:not([hidden]){
  font-size:0!important;
  color:transparent!important
}
.experimental-view-loading:not([hidden])::before{
  content:"";
  width:26px;
  height:26px;
  box-sizing:border-box;
  border:3px solid rgba(216,207,203,.16);
  border-top-color:#e6ddd8;
  border-right-color:rgba(230,221,216,.55);
  border-radius:50%;
  animation:experimental-loading-spin .65s linear infinite
}
@keyframes experimental-loading-spin{to{transform:rotate(360deg)}}
`;
document.head.append(style);

let bar=null,surface=null,commandbar=null;
let status=null,loader=null,loadingObserver=null;
function syncLoadingIndicator(){
  if(!status||!loader)return;
  const busy=!loader.hidden;
  const text=String(loader.textContent||status.textContent||'').trim();
  if(busy){
    loader.title=text;
    loader.setAttribute('aria-label',text||'Loading');
  }else{
    loader.removeAttribute('title');
    loader.removeAttribute('aria-label');
  }
}
function bindLoadingIndicator(){
  const nextStatus=bar?.querySelector('.experimental-view-status');
  const nextLoader=surface?.querySelector('.experimental-view-loading');
  if(!nextStatus||!nextLoader)return;
  if(nextStatus===status&&nextLoader===loader){syncLoadingIndicator();return}
  loadingObserver?.disconnect();
  status=nextStatus;loader=nextLoader;
  loadingObserver=new MutationObserver(syncLoadingIndicator);
  loadingObserver.observe(status,{childList:true,characterData:true,subtree:true});
  loadingObserver.observe(loader,{attributes:true,attributeFilter:['hidden'],childList:true,characterData:true,subtree:true});
  syncLoadingIndicator();
}
function syncGeometry(){
  if(!root.classList.contains('experimental-view-active')||!bar||!commandbar)return;
  const rect=commandbar.getBoundingClientRect();
  root.style.setProperty('--experimental-bar-top',`${Math.round(rect.top)}px`);
  root.style.setProperty('--experimental-bar-left',`${Math.round(rect.left)}px`);
  root.style.setProperty('--experimental-bar-width',`${Math.round(rect.width)}px`);
}
function detachExperimentalChrome(){
  bar=document.querySelector('.experimental-view-bar');
  surface=document.querySelector('.experimental-view-surface');
  commandbar=document.querySelector('.commandbar');
  if(!bar||!surface||!commandbar)return false;
  bar.querySelector('.experimental-view-fit')?.remove();
  if(bar.parentElement!==document.body)document.body.append(bar);
  if(surface.parentElement!==document.body)document.body.append(surface);
  bindLoadingIndicator();
  syncGeometry();
  return true;
}

const mountObserver=new MutationObserver(()=>{
  if(detachExperimentalChrome())mountObserver.disconnect();
});
if(!detachExperimentalChrome())mountObserver.observe(document.body,{childList:true,subtree:true});

new MutationObserver(()=>{syncGeometry();syncLoadingIndicator()}).observe(root,{attributes:true,attributeFilter:['class']});
window.addEventListener('resize',syncGeometry,{passive:true});
if(globalThis.ResizeObserver){
  const resizeObserver=new ResizeObserver(syncGeometry);
  const watch=()=>{
    if(!detachExperimentalChrome())return requestAnimationFrame(watch);
    resizeObserver.observe(commandbar);
    resizeObserver.observe(bar);
  };
  watch();
}
queueMicrotask(detachExperimentalChrome);
