import { parentPort } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

let stream = null;
let resume = null;
parentPort.on('message', async message => {
  if (message.type === 'continue') { resume?.(); resume = null; return; }
  if (message.type === 'cancel') { stream?.destroy(new Error('Canceled')); resume?.(); resume = null; return; }
  if (message.type !== 'hash') return;
  try {
    const hash = createHash('sha256');
    let read = 0, reported = 0;
    stream = createReadStream(message.path, { highWaterMark:1024 * 1024 });
    for await (const chunk of stream) {
      hash.update(chunk);
      read += chunk.length;
      if (read - reported >= 8 * 1024 * 1024) {
        reported = read;
        await new Promise(resolve => { resume = resolve; parentPort.postMessage({ type:'progress', read }); });
      }
    }
    parentPort.postMessage({ type:'done', hash:hash.digest('hex'), read });
  } catch (error) { parentPort.postMessage({ type:'error', error:error.message, code:error.code }); }
  finally { stream = null; }
});
