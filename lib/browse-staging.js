const MAX_RECENT_ROWS = 4000;
const TRIM_RECENT_AT = MAX_RECENT_ROWS * 2;

const roots = new Map();
const hashes = new Map();
let recent = [];
let sequence = 0;

function publicRow(row) {
  return {
    root: row.root,
    path: row.path,
    size: row.size,
    mtimeMs: row.mtimeMs,
    hash: row.hash
  };
}

function rootStage(root) {
  root = String(root);
  let stage = roots.get(root);
  if (!stage) {
    stage = { rows: new Map(), files: 0, bytes: 0 };
    roots.set(root, stage);
  }
  return stage;
}

function isCurrent(row) {
  return roots.get(row.root)?.rows.get(row.path) === row;
}

function removeHash(row) {
  const matches = hashes.get(row.hash);
  if (!matches) return;
  matches.delete(row);
  if (!matches.size) hashes.delete(row.hash);
}

function saveMany(root, rows) {
  if (!rows?.length) return;
  root = String(root);
  const stage = rootStage(root);

  for (const value of rows) {
    const path = String(value.path);
    const previous = stage.rows.get(path);
    if (previous) {
      stage.bytes -= previous.size;
      removeHash(previous);
    } else stage.files++;

    const row = {
      root,
      path,
      size: Number(value.size) || 0,
      mtimeMs: Math.trunc(Number(value.mtimeMs)) || 0,
      hash: String(value.hash),
      sequence: ++sequence
    };
    stage.rows.set(path, row);
    stage.bytes += row.size;

    if (!hashes.has(row.hash)) hashes.set(row.hash, new Set());
    hashes.get(row.hash).add(row);
    recent.push(row);
  }

  // UI readers only request the newest 4k staged rows. Keep that hot window
  // bounded while the hash index retains every staged row needed to open files.
  if (recent.length > TRIM_RECENT_AT) recent = recent.filter(isCurrent).slice(-MAX_RECENT_ROWS);
}

function clear(root) {
  root = String(root);
  const stage = roots.get(root);
  if (!stage) return;
  roots.delete(root);
  for (const row of stage.rows.values()) removeHash(row);
  recent = recent.filter(row => row.root !== root);
}

export function openBrowseStage() {
  // Browse staging only exists while a folder is being indexed. Keeping it in
  // memory avoids synchronous SQLite commits on the Agent event loop; the full
  // canonical index is still published to SQLite when the scan completes.
  return {
    saveMany,
    clear,
    close() {}
  };
}

export function browseStageRows(limit = 720) {
  const safeLimit = Math.max(1, Math.min(MAX_RECENT_ROWS, Number(limit) || 720));
  const rows = [];
  for (let index = recent.length - 1; index >= 0 && rows.length < safeLimit; index--) {
    const row = recent[index];
    if (isCurrent(row)) rows.push(publicRow(row));
  }
  return rows;
}

export function browseStageByHashes(wanted) {
  if (!wanted?.length) return [];
  return wanted.map(hash => {
    const matches = hashes.get(String(hash));
    if (!matches) return null;
    let newest = null;
    for (const row of matches) {
      if (!isCurrent(row)) continue;
      if (!newest || row.sequence > newest.sequence) newest = row;
    }
    return newest && publicRow(newest);
  }).filter(Boolean);
}

export function browseStageStats(root) {
  const stage = roots.get(String(root));
  return stage ? { files: stage.files, bytes: stage.bytes } : { files: 0, bytes: 0 };
}
