import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR, TOKEN, json, readJson, cookie, now } from './lib/server-context.js';

const AUTH_PATH = join(DATA_DIR, 'auth.json');
const USERNAME = String(process.env.MOCHIMONO_USERNAME || 'admin');
const PASSWORD = String(process.env.MOCHIMONO_PASSWORD || 'dev');

function equal(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && timingSafeEqual(left, right);
}

function deviceToken(req) {
  const auth = String(req.headers.authorization || '');
  return auth.startsWith('Bearer ') ? auth.slice(7) : cookie(req, 'mochimono_device');
}

const tokenHash = token => createHash('sha256').update(String(token)).digest('hex');

async function loadAuth() {
  try {
    const data = JSON.parse(await readFile(AUTH_PATH, 'utf8'));
    return { devices: Array.isArray(data.devices) ? data.devices : [] };
  } catch {
    return { devices: [] };
  }
}

async function saveAuth(data) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(AUTH_PATH, `${JSON.stringify(data, null, 2)}\n`);
}

async function issueDevice(name) {
  const token = randomBytes(32).toString('base64url');
  const data = await loadAuth();
  data.devices = data.devices.filter(item => item?.hash);
  data.devices.push({
    id: randomBytes(8).toString('hex'),
    name: String(name || 'Mochimono Client').slice(0, 100),
    hash: tokenHash(token),
    createdAt: now(),
    lastSeenAt: now()
  });
  await saveAuth(data);
  return token;
}

async function acceptDevice(req) {
  const token = deviceToken(req);
  if (!token) return false;
  const hash = tokenHash(token);
  const data = await loadAuth();
  const device = data.devices.find(item => equal(item.hash, hash));
  if (!device) return false;
  device.lastSeenAt = now();
  saveAuth(data).catch(() => {});
  return true;
}

async function revokeDevice(req) {
  const token = deviceToken(req);
  if (!token) return false;
  const hash = tokenHash(token);
  const data = await loadAuth();
  const before = data.devices.length;
  data.devices = data.devices.filter(item => !equal(item.hash, hash));
  if (data.devices.length === before) return false;
  await saveAuth(data);
  return true;
}

async function credentials(req) {
  const body = await readJson(req, 64 * 1024);
  if (!equal(body.username, USERNAME) || !equal(body.password, PASSWORD)) {
    throw Object.assign(new Error('Invalid username or password'), { status: 401 });
  }
  return body;
}

export async function handleServerAuth(req, res, url) {
  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    const body = await credentials(req);
    json(res, 200, { token: await issueDevice(body.device), username: USERNAME });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/session') {
    await credentials(req);
    const token = await issueDevice('Server browser');
    json(res, 200, { ok: true, username: USERNAME }, {
      'set-cookie': `mochimono_device=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/revoke-self') {
    if (!await revokeDevice(req)) json(res, 401, { error: 'Unauthorized' });
    else json(res, 200, { ok: true });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    await revokeDevice(req).catch(() => false);
    json(res, 200, { ok: true }, {
      'set-cookie': 'mochimono_device=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'
    });
    return true;
  }

  if (url.pathname.startsWith('/api/') && await acceptDevice(req)) {
    req.headers.authorization = `Bearer ${TOKEN}`;
  }
  return false;
}
