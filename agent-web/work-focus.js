const id=crypto.randomUUID();
let timer=0,sequence=0;
function report(){
  clearTimeout(timer);
  const focused=document.visibilityState==='visible'&&document.hasFocus();
  fetch('/api/work/focus',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,focused,sequence:++sequence}),keepalive:!focused}).catch(()=>{});
  if(focused)timer=setTimeout(report,1500);
}
window.addEventListener('focus',report);
window.addEventListener('blur',report);
document.addEventListener('visibilitychange',report);
window.addEventListener('pagehide',()=>{
  clearTimeout(timer);
  fetch('/api/work/focus',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,focused:false,sequence:++sequence}),keepalive:true}).catch(()=>{});
});
report();
