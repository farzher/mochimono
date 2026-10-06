import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { installFile } from './durable-file.js';
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

export async function writeVerifiedObject({ root, hash, input }) {
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

    // The incoming digest is verified. Existing catalog state is not proof
    // that an older destination is still intact; atomically install this copy.
    await installFile(temp, destination);
    return { size, path:destination, written:true };
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
