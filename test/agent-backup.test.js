import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
async function body(req) {
  const chunks=[]; for await(const chunk of req) chunks.push(chunk);
  const raw=Buffer.concat(chunks); return raw.length ? JSON.parse(raw) : {};
}

test('agent backup survives primary loss and restores through HTTP', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mochimono-agent-backup-'));
  const home = join(root, 'home');
  const backup = join(root, 'backup');
  await mkdir(home, { recursive: true });
  await mkdir(backup, { recursive: true });

  const content = Buffer.from('backup round trip\n');
  const hash = createHash('sha256').update(content).digest('hex');
  const timestamp = '2026-08-30T12:00:00.000Z';
  const catalogPath = join(root, 'catalog.sqlite');
  const catalog = new DatabaseSync(catalogPath);
  catalog.exec(`
    CREATE TABLE objects(hash TEXT PRIMARY KEY, size INTEGER NOT NULL, mime TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
    CREATE TABLE imports(id INTEGER PRIMARY KEY, source_name TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
    CREATE TABLE sources(id INTEGER PRIMARY KEY, object_hash TEXT NOT NULL, import_id INTEGER NOT NULL, original_path TEXT NOT NULL, filename TEXT NOT NULL, mtime TEXT, created_at TEXT NOT NULL) STRICT;
    CREATE TABLE import_roots(import_id INTEGER PRIMARY KEY, device_name TEXT NOT NULL, root_path TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
    CREATE TABLE media_metadata(object_hash TEXT PRIMARY KEY, captured_at TEXT, source TEXT NOT NULL, checked_at TEXT NOT NULL) STRICT;
  `);
  catalog.prepare('INSERT INTO objects VALUES(?,?,?,?,?)').run(hash, content.length, 'text/plain', 'active', timestamp);
  catalog.prepare('INSERT INTO imports VALUES(?,?,?)').run(1, 'Laptop', timestamp);
  catalog.prepare('INSERT INTO sources VALUES(?,?,?,?,?,?,?)').run(1, hash, 1, 'docs/file.txt', 'file.txt', timestamp, timestamp);
  catalog.prepare('INSERT INTO import_roots VALUES(?,?,?,?)').run(1, 'Laptop', 'C:/Docs', timestamp);
  catalog.prepare('INSERT INTO media_metadata VALUES(?,?,?,?)').run(hash, timestamp, 'filesystem.mtime', timestamp);
  catalog.close();

  const state = {
    objects: new Map([[hash, content]]),
    imports: [{ id: 1, sourceName: 'Laptop' }],
    sources: new Map([['1:docs/file.txt', { hash, path: 'docs/file.txt', filename: 'file.txt', mtime: timestamp, importId: 1 }]]),
    roots: new Map([[1, { importId: 1, deviceName: 'Laptop', rootPath: 'C:/Docs' }]]),
    metadata: new Map([[hash, { capturedAt: timestamp, source: 'filesystem.mtime' }]]),
    nextImport: 2,
    replicas: new Set()
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.headers.authorization !== 'Bearer test-token') return json(res, 401, { error: 'Unauthorized' });
    if (req.method === 'POST' && url.pathname === '/api/drives/register') {
      return json(res, 200, { id: 'drive', policy: { all: true }, desiredCount: state.objects.size, desiredBytes: [...state.objects.values()].reduce((n,b)=>n+b.length,0), protectedCount: state.replicas.size, protectedBytes: state.replicas.has(hash) ? content.length : 0 });
    }
    if (req.method === 'GET' && /^\/api\/drives\/[^/]+\/desired$/.test(url.pathname)) {
      return json(res, 200, { objects: state.objects.has(hash) ? [{ hash, size: content.length, mime: 'text/plain' }] : [], nextAfter: null });
    }
    if (req.method === 'POST' && /^\/api\/drives\/[^/]+\/replicas$/.test(url.pathname)) {
      const data = await body(req); for (const item of data.replicas || []) state.replicas.add(item.hash); return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && /^\/api\/drives\/[^/]+\/replicas\/remove$/.test(url.pathname)) return json(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === `/api/objects/${hash}`) {
      const value = state.objects.get(hash); if (!value) return json(res, 404, { error: 'missing' });
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': value.length }); return res.end(value);
    }
    if (req.method === 'GET' && url.pathname === '/api/catalog/export') {
      const file = await readFile(catalogPath); res.writeHead(200, { 'content-type': 'application/vnd.sqlite3', 'content-length': file.length }); return res.end(file);
    }
    if (req.method === 'POST' && url.pathname === '/api/objects/check') {
      const data = await body(req); const hashes=data.hashes||[]; return json(res,200,{known:hashes.filter(h=>state.objects.has(h)),missing:hashes.filter(h=>!state.objects.has(h)),ignored:[]});
    }
    if (req.method === 'PUT' && url.pathname === `/api/objects/${hash}`) {
      const chunks=[]; for await(const chunk of req) chunks.push(chunk); state.objects.set(hash,Buffer.concat(chunks)); return json(res,201,{ok:true});
    }
    if (req.method === 'GET' && url.pathname === '/api/imports') return json(res,200,{imports:state.imports});
    if (req.method === 'POST' && url.pathname === '/api/imports') { const data=await body(req); const item={id:state.nextImport++,sourceName:data.sourceName};state.imports.push(item);return json(res,201,item); }
    if (req.method === 'POST' && url.pathname === '/api/sources') { const data=await body(req); for(const s of data.sources||[]) state.sources.set(`${data.importId}:${s.path}`,{...s,importId:data.importId}); return json(res,200,{ok:true}); }
    if (req.method === 'POST' && url.pathname === '/api/import-roots') { const data=await body(req); for(const item of data.roots||[]) state.roots.set(item.importId,item); return json(res,200,{ok:true}); }
    const metadata=/^\/api\/media-metadata\/([a-f0-9]{64})$/.exec(url.pathname);
    if (metadata && req.method === 'POST') { state.metadata.set(metadata[1],await body(req)); return json(res,200,{ok:true}); }
    return json(res,404,{error:`Unhandled ${req.method} ${url.pathname}`});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  process.env.HOME = home;
  process.env.MOCHIMONO_URL = `http://127.0.0.1:${port}`;
  process.env.MOCHIMONO_TOKEN = 'test-token';
  const { backupInit, backupUpdate, backupRestore, backupContents } = await import(`../lib/agent-backups.js?test=${Date.now()}`);

  try {
    await backupInit(backup, 'Recovery');
    const updated = await backupUpdate(backup);
    assert.equal(updated.copied, 1);
    assert.equal((await backupContents(backup)).count, 1);

    state.objects.clear(); state.imports=[]; state.sources.clear(); state.roots.clear(); state.metadata.clear(); state.replicas.clear(); state.nextImport=1;
    const restored = await backupRestore(backup);
    assert.equal(restored.restored, 1);
    assert.deepEqual(state.objects.get(hash), content);
    assert.equal(state.sources.get('1:docs/file.txt').filename, 'file.txt');
    assert.equal(state.roots.get(1).rootPath, 'C:/Docs');
    assert.equal(state.metadata.get(hash).capturedAt, timestamp);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
