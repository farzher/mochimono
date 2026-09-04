import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathKey, settings, SYNC_INDEX_PATH } from './agent-context.js';
import { backgroundWorkAllowed } from './background-work.js';
import { mimeFor } from './mime.js';
import { providerThumbnail, providerThumbnailQueueStatus } from './provider-thumbs.js';
import { openSyncIndex } from './sync-index.js';

const MAX_FAST_FILE_BYTES = 32 * 1024 * 1024;
const MAX_FAST_PASS_BYTES = 64 * 1024 * 1024;
const MAX_FAST_PASS_FILES = 24;
const ACTIVE_RETRY_MS = 500;
const IDLE_RETRY_MS = 5000;

let timer = null;
let running = false;
let repaired = false;
let changed = () => {};

const browseRootKey = root => `browse:${pathKey(root)}`;
const fullPath = (root, relativePath) => join(root, ...String(relativePath || '').replaceAll('\\', '/').split('/').filter(Boolean));
const media = path => {
  const mime = mimeFor(path);
  return mime.startsWith('image/') || mime.startsWith('video/');
};

function schedule(delay = ACTIVE_RETRY_MS) {
  if (timer) return;
  timer = setTimeout(run, Math.max(50, delay));
  timer.unref?.();
}

function repairKnownDuplicates() {
  const index = openSyncIndex(SYNC_INDEX_PATH);
  let promoted = 0;
  try {
    const duplicates = index.duplicateBrowseContentHashes();
    promoted = index.promoteBrowseContentHashes([...duplicates]);
  } finally { index.close(); }
  if (promoted) changed();
  return promoted;
}

function candidates() {
  const index = openSyncIndex(SYNC_INDEX_PATH);
  const sizes = new Map();
  const pending = [];
  try {
    for (const root of settings.browseFolders) {
      const key = browseRootKey(root);
      const files = index.load(key);
      const states = index.browseHashState(key);

      for (const row of files.values()) {
        const size = Number(row.size) || 0;
        if (size > 0) sizes.set(size, (sizes.get(size) || 0) + 1);
      }

      for (const [path, state] of states) {
        if (state.contentHash) continue;
        const file = files.get(path);
        const size = Number(state.size) || 0;
        if (!file?.hash || !size || size > MAX_FAST_FILE_BYTES || !media(path)) continue;
        pending.push({
          root,
          key,
          path,
          size,
          mtimeMs: Math.trunc(Number(state.mtimeMs) || 0),
          hash: String(file.hash)
        });
      }
    }
  } finally { index.close(); }

  return pending
    .filter(row => (sizes.get(row.size) || 0) > 1)
    .sort((a, b) => a.size - b.size || a.path.localeCompare(b.path));
}

async function contentHash(row) {
  // Only spend this early I/O after the item is already visually useful. The
  // normal full hash pass still handles everything that does not qualify here.
  if (!await providerThumbnail(row.hash)) return '';

  const path = fullPath(row.root, row.path);
  const before = await stat(path).catch(() => null);
  if (!before?.isFile() || Number(before.size) !== row.size || Math.trunc(before.mtimeMs) !== row.mtimeMs) return '';

  const bytes = await readFile(path).catch(() => null);
  if (!bytes || bytes.length !== row.size) return '';

  const after = await stat(path).catch(() => null);
  if (!after?.isFile() || Number(after.size) !== row.size || Math.trunc(after.mtimeMs) !== row.mtimeMs) return '';
  return createHash('sha256').update(bytes).digest('hex');
}

async function learn(rows) {
  const writes = new Map();
  const learnedHashes = new Set();
  let bytes = 0;
  let files = 0;

  for (const row of rows) {
    if (files >= MAX_FAST_PASS_FILES) break;
    if (bytes && bytes + row.size > MAX_FAST_PASS_BYTES) break;
    const hash = await contentHash(row);
    if (!hash) continue;

    let list = writes.get(row.key);
    if (!list) writes.set(row.key, list = []);
    list.push({ path: row.path, size: row.size, mtimeMs: row.mtimeMs, contentHash: hash });
    learnedHashes.add(hash);
    bytes += row.size;
    files++;
  }

  if (!writes.size) return { learned: 0, promoted: 0 };

  const index = openSyncIndex(SYNC_INDEX_PATH);
  let learned = 0;
  let promoted = 0;
  try {
    for (const [root, list] of writes) learned += index.saveBrowseContentHashes(root, list);
    const duplicates = index.duplicateBrowseContentHashes([...learnedHashes]);
    promoted = index.promoteBrowseContentHashes([...duplicates]);
  } finally { index.close(); }

  if (promoted) changed();
  return { learned, promoted };
}

async function run() {
  timer = null;
  if (running) return schedule(ACTIVE_RETRY_MS);

  running = true;
  try {
    if (!repaired) {
      repairKnownDuplicates();
      repaired = true;
    }
    if (settings.thumbnailMode === 'off') return schedule(IDLE_RETRY_MS);
    if (settings.thumbnailMode === 'idle' && !backgroundWorkAllowed()) return schedule(1000);
    if (providerThumbnailQueueStatus().urgent > 0) return schedule(250);

    const rows = candidates();
    if (!rows.length) return schedule(IDLE_RETRY_MS);
    const result = await learn(rows);
    schedule(result.learned ? ACTIVE_RETRY_MS : 1000);
  } catch (error) {
    console.warn(`Mochimono fast dedupe paused: ${error?.message || error}`);
    schedule(2000);
  } finally {
    running = false;
  }
}

export function startBrowseFastDedupe(changeHandler = () => {}) {
  changed = typeof changeHandler === 'function' ? changeHandler : () => {};
  schedule(750);
}
