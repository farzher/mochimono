import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSyncIndex } from '../lib/sync-index.js';

test('sync index is minimal, reusable, and reports folder totals', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mochimono-index-'));
  const db = openSyncIndex(join(dir, 'index.sqlite'));
  try {
    db.save('/root', 'a.txt', 10, 100, 'a'.repeat(64));
    db.save('/root', 'b.txt', 20, 200, 'b'.repeat(64));
    assert.deepEqual(db.stats('/root'), { files: 2, bytes: 30 });
    db.prune('/root', new Set(['b.txt']));
    assert.deepEqual(db.stats('/root'), { files: 1, bytes: 20 });
    assert.equal(db.load('/root').get('b.txt').hash, 'b'.repeat(64));
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
