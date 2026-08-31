import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForServer(base, child) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode != null) throw new Error(`Server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'dev', device: 'test' })
      });
      if (response.ok) return (await response.json()).token;
    } catch {}
    await sleep(50);
  }
  throw new Error('Server did not start');
}

async function api(base, token, path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { authorization: `Bearer ${token}`, ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => null);
  assert.equal(response.ok, true, `${response.status} ${path}: ${JSON.stringify(data)}`);
  return data;
}

test('server stores, catalogs, scopes, locates, and deletes objects', async t => {
  const data = await mkdtemp(join(tmpdir(), 'mochimono-server-'));
  const port = 19000 + Math.floor(Math.random() * 1000);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      MOCHIMONO_DATA: data,
      MOCHIMONO_TOKEN: 'test-master-token',
      MOCHIMONO_USERNAME: 'admin',
      MOCHIMONO_PASSWORD: 'dev',
      HOST: '127.0.0.1',
      PORT: String(port)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    child.kill();
    await rm(data, { recursive: true, force: true });
  });

  const token = await waitForServer(base, child);
  const anonymous = await fetch(`${base}/api/health`);
  assert.equal(anonymous.status, 401);
  assert.deepEqual(await api(base, token, '/api/health'), { ok: true });

  const content = Buffer.from('mochimono smoke object');
  const hash = createHash('sha256').update(content).digest('hex');
  await api(base, token, `/api/objects/${hash}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream', 'x-mochimono-mime': 'text/plain' },
    body: content
  });

  const imported = await api(base, token, '/api/imports', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceName: 'smoke' })
  });
  await api(base, token, '/api/sources', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ importId: imported.id, sources: [{ hash, path: 'folder/a.txt', filename: 'a.txt', mtime: '2026-08-30T12:00:00.000Z' }] })
  });

  const catalog = await api(base, token, '/api/catalog');
  assert.equal(catalog.files.length, 1);
  assert.equal(catalog.files[0].hash, hash);
  assert.equal(catalog.files[0].filename, 'a.txt');

  const smart = await api(base, token, '/api/smart-collections', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Text files', spec: { query: 'name:a.txt' } })
  });
  const drive = await api(base, token, '/api/drives/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'test-drive', name: 'Test drive', policy: { all: false, collectionId: smart.id, collectionName: smart.name } })
  });
  assert.equal(drive.desiredCount, 1);
  const desired = await api(base, token, '/api/drives/test-drive/desired');
  assert.deepEqual(desired.objects.map(item => item.hash), [hash]);

  await api(base, token, '/api/drives/test-drive/replicas', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ replicas: [{ hash, verifiedAt: '2026-08-31T12:00:00.000Z' }] })
  });
  const stored = await api(base, token, '/api/drives/test-drive/files');
  assert.deepEqual(stored.files, [{ hash, verifiedAt: '2026-08-31T12:00:00.000Z' }]);

  await api(base, token, `/api/smart-collections/${smart.id}`, { method: 'DELETE' });
  const drives = await api(base, token, '/api/drives');
  assert.equal(drives.drives[0].policy.missing, true);

  await api(base, token, `/api/objects/${hash}/delete`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
  });
  const checked = await api(base, token, '/api/objects/check', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hashes: [hash] })
  });
  assert.deepEqual(checked.missing, [hash]);
});
