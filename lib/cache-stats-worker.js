import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

async function previewCacheStats(root) {
  let bytes = 0;
  let files = 0;
  const stack = [resolve(String(root), 'provider-thumbs')];
  while (stack.length) {
    const directory = stack.pop();
    const entries = await readdir(directory, { withFileTypes:true }).catch(() => []);
    const previews = [];
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile() && /^[a-f0-9]{64}\.webp$/i.test(entry.name)) previews.push(path);
    }
    for (const info of await Promise.all(previews.map(path => stat(path).catch(() => null)))) {
      if (!info) continue;
      bytes += Number(info.size) || 0;
      files++;
    }
  }
  return { bytes, files };
}

parentPort?.postMessage(await previewCacheStats(workerData.root));
