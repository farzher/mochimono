import { Worker } from 'node:worker_threads';
import { withDriveRead } from './drive-read.js';

const idle = [];
export async function hashFile(path, { progress, check = () => {}, wait = async () => {} } = {}) {
  await wait();
  check();
  const worker = idle.pop() || new Worker(new URL('./file-hash-worker.js', import.meta.url));
  worker.ref();
  return new Promise((resolve, reject) => {
    let settled = false;
    let releaseLane = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      releaseLane?.();
      // Keep Worker's internal listeners: they restart message delivery when
      // this worker is reused. Removing them stalls the next hash and disk lane.
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
      if (error) void worker.terminate();
      else { worker.unref(); idle.push(worker); }
      error ? reject(error) : resolve(value);
    };
    const step = async type => {
      try {
        await wait();
        check();
        await withDriveRead(path, () => new Promise(release => {
          if (settled) return release();
          releaseLane = release;
          worker.postMessage({ type, ...(type === 'hash' ? { path } : {}) });
        }));
      } catch (error) { finish(error); }
    };
    const onMessage = message => {
      // Yield the drive every 8 MiB without restarting the digest or rereading
      // bytes. Interactive originals can interrupt even a multi-GB hash pass.
      releaseLane?.();
      releaseLane = null;
      try {
        if (message.type === 'error') throw Object.assign(new Error(message.error), { code:message.code });
        check();
        progress?.(message.read, message.type === 'done');
        if (message.type === 'done') finish(null, message.hash);
        else void step('continue');
      } catch (error) { finish(error); }
    };
    const onError = error => finish(error);
    const onExit = code => finish(new Error(`Hash worker exited (${code})`));
    worker.on('message', onMessage);
    worker.once('error', onError);
    worker.once('exit', onExit);
    void step('hash');
  });
}
