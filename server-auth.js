import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import http from 'node:http';

const DATA_DIR = resolve(process.env.MOCHIMONO_DATA || join(process.cwd(), 'data'));
const AUTH_PATH = join(DATA_DIR, 'auth.json');
const WEB_INDEX = new URL('./web/index.html', import.meta.url);
const MASTER_TOKEN = String(process.env.MOCHIMONO_TOKEN || '');
const USERNAME = String(process.env.MOCHIMONO_USERNAME || 'admin');
const PASSWORD = String(process.env.MOCHIMONO_PASSWORD || 'dev');
const now = () => new Date().toISOString();

function json(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers
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

function cookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return '';
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
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : cookie(req, 'mochimono_device');
  if (!token) return false;
  const hash = tokenHash(token);
  const data = await loadAuth();
  const device = data.devices.find(item => equal(item.hash, hash));
  if (!device) return false;
  device.lastSeenAt = now();
  saveAuth(data).catch(() => {});
  return true;
}

async function credentials(req) {
  const body = await readJson(req);
  if (!equal(body.username, USERNAME) || !equal(body.password, PASSWORD)) {
    throw Object.assign(new Error('Invalid username or password'), { status: 401 });
  }
  return body;
}

async function serverIndex(res) {
  let html = await readFile(WEB_INDEX, 'utf8');
  html = html.replace('</body>', `<script>
  addEventListener('DOMContentLoaded',()=>{
    const form=document.querySelector('#login-form');
    const username=document.querySelector('#token');
    const logout=document.querySelector('#logout');
    if(form&&username){
      username.type='text';username.id='username';username.placeholder='Username';username.value='admin';username.autocomplete='username';
      const password=document.createElement('input');password.id='password';password.type='password';password.placeholder='Password';password.autocomplete='current-password';username.after(password);
      form.addEventListener('submit',async event=>{
        event.preventDefault();event.stopImmediatePropagation();
        const error=document.querySelector('#login-error');if(error)error.textContent='';
        try{
          const response=await fetch('/api/auth/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:username.value,password:password.value})});
          const data=await response.json().catch(()=>({}));
          if(!response.ok)throw new Error(data.error||response.statusText);
          location.reload();
        }catch(e){if(error)error.textContent=e.message;}
      },true);
    }
    if(logout)logout.addEventListener('click',async event=>{event.preventDefault();event.stopImmediatePropagation();await fetch('/api/auth/logout',{method:'POST'}).catch(()=>{});location.reload();},true);
  });
  </script></body>`);
  res.writeHead(200, {'content-type':'text/html; charset=utf-8','content-length':Buffer.byteLength(html),'cache-control':'no-cache'});
  res.end(html);
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
      if (req.method === 'GET' && url.pathname === '/') return await serverIndex(res);

      if (req.method === 'POST' && url.pathname === '/api/auth/login') {
        const body = await credentials(req);
        return json(res, 200, { token: await issueDevice(body.device), username: USERNAME });
      }

      if (req.method === 'POST' && url.pathname === '/api/auth/session') {
        await credentials(req);
        const token = await issueDevice('Server browser');
        return json(res, 200, { ok: true, username: USERNAME }, {
          'set-cookie': `mochimono_device=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
        return json(res, 200, { ok: true }, {
          'set-cookie': 'mochimono_device=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'
        });
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