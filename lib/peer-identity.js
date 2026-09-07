import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as signBytes,
  verify as verifyBytes
} from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_DIR } from './agent-context.js';

const IDENTITY_PATH = join(CONFIG_DIR, 'peer-identity.json');
let cached = null;

export function deviceIdForPublicKey(publicKey) {
  const bytes = Buffer.from(String(publicKey || ''), 'base64url');
  if (!bytes.length) return '';
  return createHash('sha256').update(bytes).digest('hex');
}

function loadPublicKey(publicKey) {
  return createPublicKey({ key: Buffer.from(String(publicKey || ''), 'base64url'), format: 'der', type: 'spki' });
}

export function verifyPeerSignature(publicKey, payload, signature) {
  try {
    return verifyBytes(null, Buffer.from(String(payload)), loadPublicKey(publicKey), Buffer.from(String(signature || ''), 'base64url'));
  } catch {
    return false;
  }
}

export async function getPeerIdentity() {
  if (cached) return cached;
  try {
    const saved = JSON.parse(await readFile(IDENTITY_PATH, 'utf8'));
    const publicKey = String(saved.publicKey || '');
    const privateKey = String(saved.privateKey || '');
    if (deviceIdForPublicKey(publicKey) === saved.deviceId && privateKey) {
      const key = createPrivateKey({ key: Buffer.from(privateKey, 'base64url'), format: 'der', type: 'pkcs8' });
      cached = {
        deviceId: saved.deviceId,
        publicKey,
        sign(payload) {
          return signBytes(null, Buffer.from(String(payload)), key).toString('base64url');
        }
      };
      return cached;
    }
  } catch {}

  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
  const privateKey = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url');
  const deviceId = deviceIdForPublicKey(publicKey);
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(IDENTITY_PATH, `${JSON.stringify({ version: 1, deviceId, publicKey, privateKey }, null, 2)}\n`, { mode: 0o600 });
  const key = pair.privateKey;
  cached = {
    deviceId,
    publicKey,
    sign(payload) {
      return signBytes(null, Buffer.from(String(payload)), key).toString('base64url');
    }
  };
  return cached;
}
