const sortSelect=document.querySelector('#sort');
const root=document.documentElement;
const randomKeys=new Map();
let randomMode=false;
let seed=0;
let libraryWrapped=false;

function newSeed(){
  if(globalThis.crypto?.getRandomValues){const value=new Uint32Array(1);crypto.getRandomValues(value);return value[0]||1}
  return((Math.random()*0xffffffff)>>>0)||1;
}
function mix(value){value^=value>>>16;value=Math.imul(value,0x7feb352d)>>>0;value^=value>>>15;value=Math.imul(value,0x846ca68b)>>>0;value^=value>>>16;return value>>>0}
function randomKey(hash){
  if(randomKeys.has(hash))return randomKeys.get(hash);
  let value=(2166136261^seed)>>>0;const text=String(hash||'');for(let i=0;i<text.length;i++){value^=text.charCodeAt(i);value=Math.imul(value,16777619)>>>0}
  const key=mix(value);randomKeys.set(hash,key);return key;
}
export function sortRandom(items){
  if(!seed)seed=newSeed();
  // Hash once per file, not twice for every comparison in an O(n log n) sort.
  for(const item of items)randomKey(item.hash);
  return items.sort((a,b)=>randomKeys.get(a.hash)-randomKeys.get(b.hash)||a.hash.localeCompare(b.hash));
}
function setMode(enabled,fresh=false){randomMode=Boolean(enabled);if(randomMode&&(fresh||!seed)){seed=newSeed();randomKeys.clear()}root.classList.toggle('random-sort-active',randomMode)}
function installOption(){
  if(!sortSelect||sortSelect.querySelector('option[value="random"]'))return;
  const option=document.createElement('option');option.value='random';option.textContent='Random';
  const size=sortSelect.querySelector('option[value="size-desc"]');size?size.after(option):sortSelect.append(option);
}
function wrapLibrary(){
  const library=window.mochimonoLibrary;
  if(!library||libraryWrapped){if(!libraryWrapped)requestAnimationFrame(wrapLibrary);return}
  libraryWrapped=true;
  const originalSetSort=library.setSort.bind(library);
  library.setSort=value=>{const next=String(value||'date-desc');setMode(next==='random',next==='random');return originalSetSort(next)};
}
installOption();
sortSelect?.addEventListener('change',()=>setMode(sortSelect.value==='random',sortSelect.value==='random'),true);
const style=document.createElement('style');
style.textContent='html.random-sort-active #dateRail{display:none!important}html.random-sort-active{scrollbar-width:auto!important}html.random-sort-active::-webkit-scrollbar{display:block!important}';
document.head.append(style);
wrapLibrary();
