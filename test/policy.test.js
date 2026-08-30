import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePolicy, policySql } from '../lib/policy.js';

test('empty policy means everything', () => {
  assert.deepEqual(normalizePolicy(null), { all: true, types: [] });
});

test('policy removes invalid and duplicate types', () => {
  assert.deepEqual(normalizePolicy({ types: ['image', 'image', 'bogus', 'video'] }), { all: false, types: ['image', 'video'] });
});

test('policy SQL maps media classes to MIME prefixes', () => {
  assert.deepEqual(policySql({ types: ['image', 'video'] }), {
    sql: "(o.mime LIKE ? OR o.mime LIKE ?)",
    params: ['image/%', 'video/%']
  });
});
