import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// Publish the completed file before recording a durable receipt. Never unlink
// the previous good copy first: interruption must leave one complete version.
export async function installFile(temp, destination) {
  const file = await open(temp, 'r+');
  try { await file.sync(); }
  finally { await file.close(); }
  await rename(temp, destination);
  if (process.platform !== 'win32') {
    const directory = await open(dirname(destination), 'r');
    try { await directory.sync(); }
    finally { await directory.close(); }
  }
}

const writes = new Map();
export function writeJsonFile(path, value, options = {}) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const pending = (writes.get(path) || Promise.resolve()).catch(() => {}).then(async () => {
    await mkdir(dirname(path), { recursive:true });
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, text, { ...options, flag:'wx' });
      await installFile(temp, path);
    } finally { await rm(temp, { force:true }).catch(() => {}); }
  });
  writes.set(path, pending);
  const cleanup = () => { if (writes.get(path) === pending) writes.delete(path); };
  pending.then(cleanup, cleanup);
  return pending;
}
