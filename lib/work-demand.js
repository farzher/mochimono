// Short-lived demand, not a saved setting. A closed/crashed window cannot keep
// unattended work running at full speed indefinitely.
const windows = new Map();
const FOCUS_LEASE_MS = 5_000;
let requestedUntil = 0;

export function setWorkFocus(id, focused, sequence) {
  const previous=windows.get(id);
  if(previous&&sequence<=previous.sequence)return;
  const now=Date.now();
  windows.set(id,{sequence,until:focused?now+FOCUS_LEASE_MS:0,seen:now});
  if(!focused)requestedUntil=0;
}

export function noteWorkRequested() {
  requestedUntil=Date.now()+5_000;
}

export function workMode() {
  const now=Date.now();
  let focused=false;
  for(const [id,window] of windows){
    if(window.until>now)focused=true;
    else if(now-window.seen>60_000)windows.delete(id);
  }
  return focused || requestedUntil>now ? 'max' : 'idle';
}
