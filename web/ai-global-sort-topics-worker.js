let child=null;
let canceled=false;
const WORKER_REV='shared-family-v1';
const post=(type,payload={})=>self.postMessage({type,...payload});

function run(payload){return new Promise((resolve,reject)=>{const worker=new Worker(new URL(`./ai-global-sort-worker-v2.js?v=${WORKER_REV}`,import.meta.url),{type:'module'});child=worker;let done=false;const finish=(fn,value)=>{if(done)return;done=true;if(child===worker)child=null;try{worker.terminate()}catch{}fn(value)};worker.onerror=event=>finish(reject,new Error(event.message||'Semantic Rooms worker failed'));worker.onmessageerror=()=>finish(reject,new Error('Semantic Rooms worker returned unreadable data'));worker.onmessage=event=>{const data=event.data||{};if(data.type==='progress'){post('progress',data);return}if(data.type==='error'){const error=new Error(data.error||'Semantic Rooms worker failed');if(data.aborted)error.name='AbortError';finish(reject,error);return}if(data.type==='result')finish(resolve,data.result||{})};worker.postMessage({action:'sort',payload:{...(payload||{}),mode:'topics'}})})}

self.onmessage=async event=>{const data=event.data||{};if(data.action==='cancel'){canceled=true;try{child?.postMessage({action:'cancel'})}catch{}try{child?.terminate()}catch{}child=null;return}if(data.action!=='sort')return;canceled=false;try{const result=await run(data.payload||{});if(!canceled)post('result',{result})}catch(error){post('error',{error:error?.name==='AbortError'?'Canceled':String(error?.message||error),aborted:canceled||error?.name==='AbortError'})}};
