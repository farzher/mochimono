import { createHash } from 'node:crypto';
import { pathKey } from './agent-context.js';

// Local access needs a cheap identity, not a full read of the original. Content
// hashes are recorded separately and remain mandatory for stored backup data.
export function localFileId(root, path, file) {
  return createHash('sha256')
    .update(`mochimono-local-v1\0${pathKey(root)}\0${String(path)}\0${Number(file.size) || 0}\0${Math.trunc(Number(file.mtimeMs) || 0)}`)
    .digest('hex');
}
