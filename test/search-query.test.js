import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchText, queryTerms } from '../web/search-query.js';

function matches(query, file) {
  const text = buildSearchText(file);
  return queryTerms(query).every(term => text.includes(term));
}

test('location search distinguishes server backups and local folders', () => {
  const serverOnly = { filename: 'one.jpg', mime: 'image/jpeg', backupCount: 0 };
  const backedUp = { filename: 'two.jpg', mime: 'image/jpeg', backupCount: 2 };
  const local = {
    filename: 'three.jpg',
    mime: 'image/jpeg',
    backupCount: 0,
    localLocations: [{ name: 'Yoga Photos', deviceName: 'Laptop', rootPath: 'D:/Yoga' }]
  };

  assert.equal(matches('location:server', serverOnly), true);
  assert.equal(matches('location:backup', serverOnly), false);
  assert.equal(matches('location:backup', backedUp), true);
  assert.equal(matches('location:local', local), true);
  assert.equal(matches('location:"Yoga Photos"', local), true);
  assert.equal(matches('location:local', serverOnly), false);
});
