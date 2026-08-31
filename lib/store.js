import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export function validHash(hash) {
  return /^[a-f0-9]{64}$/.test(hash);
}

export function objectPath(root, hash) {
  if (!validHash(hash)) throw new Error('Invalid SHA-256 hash');
  return join(root, 'objects', hash.slice(0, 2), hash);
}

export async function writeVerifiedObject({ root, hash, input, replace = false }) {
  const destination = objectPath(root, hash);
  const temp = join(root, 'tmp', `${hash}.${process.pid}.${Date.now()}`);
  await mkdir(dirname(destination), { recursive: true });
  await mkdir(dirname(temp), { recursive: true });

  const digest = createHash('sha256');
  let size = 0;
  const verifier = new Transform({
    transform(chunk, encoding, callback) {
      digest.update(chunk);
      size += chunk.length;
      callback(null, chunk);
    }
  });

  try {
    await pipeline(input, verifier, createWriteStream(temp, { flags: 'wx' }));
    const actual = digest.digest('hex');
    if (actual !== hash) throw new Error(`Hash mismatch: expected ${hash}, got ${actual}`);

    let written = false;
    if (replace) {
      await rm(destination, { force: true });
      await rename(temp, destination);
      written = true;
    } else {
      try {
        await stat(destination);
        await rm(temp, { force: true });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await rename(temp, destination);
        written = true;
      }
    }
    return { size, path: destination, written };
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

export async function removeObject(root, hash) {
  await rm(objectPath(root, hash), { force: true });
}

export function readObject(root, hash, options = {}) {
  return createReadStream(objectPath(root, hash), options);
}
