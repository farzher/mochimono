import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { restoreBackup, inspectBackup } from '../lib/restore.js';

async function streamBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test('physical backup restores objects and provenance idempotently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mochimono-restore-'));
  const control = join(root, '.mochimono');
  await mkdir(control, { recursive: true });
  const content = Buffer.from('recovery matters\n');
  const hash = createHash('sha256').update(content).digest('hex');
  const objectPath = join(control, 'objects', hash.slice(0, 2), hash);
  await mkdir(dirname(objectPath), { recursive: true });
  await writeFile(objectPath, content);
  await writeFile(join(control, 'drive.json'), JSON.stringify({ format: 1, id: 'backup-1', name: 'Recovery', policy: { all: true } }));

  const inventory = new DatabaseSync(join(control, 'inventory.sqlite'));
  inventory.exec('CREATE TABLE objects(hash TEXT PRIMARY KEY, size INTEGER NOT NULL, stored_at TEXT NOT NULL, verified_at TEXT) STRICT');
  inventory.prepare('INSERT INTO objects VALUES(?,?,?,?)').run(hash, content.length, new Date().toISOString(), new Date().toISOString());
  inventory.close();

  const catalog = new DatabaseSync(join(control, 'catalog.sqlite'));
  catalog.exec(`
    CREATE TABLE objects(hash TEXT PRIMARY KEY, size INTEGER NOT NULL, mime TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
    CREATE TABLE imports(id INTEGER PRIMARY KEY, source_name TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
    CREATE TABLE sources(id INTEGER PRIMARY KEY, object_hash TEXT NOT NULL, import_id INTEGER NOT NULL, original_path TEXT NOT NULL, filename TEXT NOT NULL, mtime TEXT, created_at TEXT NOT NULL) STRICT;
    CREATE TABLE import_roots(import_id INTEGER PRIMARY KEY, device_name TEXT NOT NULL, root_path TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
    CREATE TABLE media_metadata(object_hash TEXT PRIMARY KEY, captured_at TEXT, source TEXT NOT NULL, checked_at TEXT NOT NULL) STRICT;
  `);
  const timestamp = '2026-08-30T12:00:00.000Z';
  catalog.prepare('INSERT INTO objects VALUES(?,?,?,?,?)').run(hash, content.length, 'text/plain', 'active', timestamp);
  catalog.prepare('INSERT INTO imports VALUES(?,?,?)').run(7, 'Laptop', timestamp);
  catalog.prepare('INSERT INTO sources VALUES(?,?,?,?,?,?,?)').run(1, hash, 7, 'docs/recovery.txt', 'recovery.txt', timestamp, timestamp);
  catalog.prepare('INSERT INTO import_roots VALUES(?,?,?,?)').run(7, 'Laptop', 'C:/Users/test/Documents', timestamp);
  catalog.prepare('INSERT INTO media_metadata VALUES(?,?,?,?)').run(hash, timestamp, 'filesystem.mtime', timestamp);
  catalog.close();

  const state = { objects: new Map(), imports: [], sources: new Map(), roots: new Map(), metadata: new Map(), nextImport: 1 };
  async function api(path, options = {}) {
    if (path === '/api/objects/check') {
      const hashes = options.body.hashes;
      return { known: hashes.filter(value => state.objects.has(value)), missing: hashes.filter(value => !state.objects.has(value)), ignored: [] };
    }
    if (/^\/api\/objects\/[a-f0-9]{64}$/.test(path) && options.method === 'PUT') {
      state.objects.set(path.split('/').pop(), await streamBuffer(options.body));
      return { ok: true };
    }
    if (path === '/api/imports' && !options.method) return { imports: state.imports };
    if (path === '/api/imports' && options.method === 'POST') {
      const item = { id: state.nextImport++, sourceName: options.body.sourceName };
      state.imports.push(item);
      return item;
    }
    if (path === '/api/sources' && options.method === 'POST') {
      for (const source of options.body.sources) state.sources.set(`${options.body.importId}:${source.path}`, { ...source, importId: options.body.importId });
      return { ok: true };
    }
    if (path === '/api/import-roots' && options.method === 'POST') {
      for (const item of options.body.roots) state.roots.set(item.importId, item);
      return { ok: true };
    }
    const metadata = /^\/api\/media-metadata\/([a-f0-9]{64})$/.exec(path);
    if (metadata && options.method === 'POST') {
      state.metadata.set(metadata[1], options.body);
      return { ok: true };
    }
    throw new Error(`Unhandled fake API ${options.method || 'GET'} ${path}`);
  }

  try {
    const inspected = await inspectBackup(root);
    assert.equal(inspected.count, 1);
    assert.equal(inspected.sample[0].path, 'docs/recovery.txt');

    const first = await restoreBackup(root, api);
    assert.equal(first.restored, 1);
    assert.deepEqual(state.objects.get(hash), content);
    assert.equal(state.imports[0].sourceName, 'Laptop');
    assert.equal(state.sources.get('1:docs/recovery.txt').filename, 'recovery.txt');
    assert.equal(state.roots.get(1).rootPath, 'C:/Users/test/Documents');
    assert.equal(state.metadata.get(hash).capturedAt, timestamp);

    const second = await restoreBackup(root, api);
    assert.equal(second.restored, 0);
    assert.equal(second.already, 1);
    assert.equal(state.sources.size, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
