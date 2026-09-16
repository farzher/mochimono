import { readdir, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

async function directoryBytes(root) {
  let bytes = 0;
  const stack = [resolve(String(root))];
  const visited = new Set();
  while (stack.length) {
    const directory = stack.pop();
    if (visited.has(directory)) continue;
    visited.add(directory);
    const entries = await readdir(directory, { withFileTypes:true }).catch(() => []);
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile()) bytes += Number((await stat(path).catch(() => null))?.size) || 0;
    }
  }
  return bytes;
}

parentPort?.postMessage({ bytes:await directoryBytes(workerData.root) });
