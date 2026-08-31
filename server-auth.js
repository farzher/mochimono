import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import http from 'node:http';

const DATA_DIR = resolve(process.env.MOCHIMONO_DATA || join(process.cwd(), 'data'));
const AUTH_PATH = join(DATA_DIR, 'auth.json');
const MASTER_TOKEN = String(process.env.MOCHIMONO_TOKEN || '');
const USERNAME = String(process.env.MOCHIMONO_USERNAME || 'admin');
const PASSWORD = String(process.env.MOCHIMONO_PASSWORD || 'dev');
const now = () => new Date().toISOString();

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  res.end(body);
}

async function readJson(req, max = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw Object.assign(new Error('Request too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

function equal(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && timingSafeEqual(left, right);
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
  data.devices = data.devices.filter(item => item && item.hash);
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
  const auth = String(req.headers.authorization || '');
  if (!auth.startsWith('Bearer ')) return false;
  const token = auth.slice(7);
  if (!token) return false;
  const hash = tokenHash(token);
  const data = await loadAuth();
  const device = data.devices.find(item => equal(item.hash, hash));
  if (!device) return false;
  device.lastSeenAt = now();
  saveAuth(data).catch(() => {});
  return true;
}

const originalCreateServer = http.createServer;
http.createServer = function (...args) {
  const context = this;
  http.createServer = originalCreateServer;
  const index = args.findIndex(value => typeof value === 'function');
  if (index < 0) return originalCreateServer.apply(context, args);
  const listener = args[index];
  args[index] = async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (req.method === 'POST' && url.pathname === '/api/auth/login') {
        const body = await readJson(req);
        if (!equal(body.username, USERNAME) || !equal(body.password, PASSWORD)) {
          return json(res, 401, { error: 'Invalid username or password' });
        }
        return json(res, 200, { token: await issueDevice(body.device), username: USERNAME });
      }

      if (url.pathname.startsWith('/api/') && await acceptDevice(req)) {
        req.headers.authorization = `Bearer ${MASTER_TOKEN}`;
      }
    } catch (error) {
      return json(res, error.status || 500, { error: error.message || 'Authentication error' });
    }
    return listener(req, res);
  };
  return originalCreateServer.apply(context, args);
};