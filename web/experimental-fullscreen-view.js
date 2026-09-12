const style=document.createElement('style');
style.textContent=`
html.experimental-view-active,html.experimental-view-active body{overflow:hidden!important}
html.experimental-view-active .topbar,
html.experimental-view-active .app-brand,
html.experimental-view-active .top-actions,
html.experimental-view-active .commandbar,
html.experimental-view-active #folderbar,
html.experimental-view-active #gridFolderStrip{display:none!important}
html.experimental-view-active .experimental-view-surface{
  position:fixed!important;
  inset:0!important;
  width:100vw!important;
  height:100dvh!important;
  min-height:0!important;
  margin:0!important;
  border:0!important;
  border-radius:0!important;
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
  z-index:30
}
@media(max-width:840px){
  html.experimental-view-active .experimental-view-bar{width:calc(100vw - 20px)!important}
}
`;
document.head.append(style);

const chromeSelectors=['.topbar','.app-brand','.top-actions','.commandbar','#folderbar','#gridFolderStrip'];
const savedDisplay=new Map();

function syncNormalChrome(){
  const active=document.documentElement.classList.contains('experimental-view-active');
  for(const selector of chromeSelectors)for(const node of document.querySelectorAll(selector)){
    if(active){
      if(!savedDisplay.has(node))savedDisplay.set(node,[node.style.getPropertyValue('display'),node.style.getPropertyPriority('display')]);
      node.style.setProperty('display','none','important');
    }else if(savedDisplay.has(node)){
      const[value,priority]=savedDisplay.get(node);
      if(value)node.style.setProperty('display',value,priority);else node.style.removeProperty('display');
      savedDisplay.delete(node);
    }
  }
}

new MutationObserver(syncNormalChrome).observe(document.documentElement,{attributes:true,attributeFilter:['class']});
syncNormalChrome();
