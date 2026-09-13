import { isAbsolute, relative, resolve } from 'node:path';
import { platform } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { pathKey, persistSettings, settings, SYNC_INDEX_PATH } from './agent-context.js';

const windows = platform() === 'win32';

function cleanRelative(value) {
  const clean = String(value || '')
    .replaceAll('\\', '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .split('/')
    .filter(Boolean)
    .join('/');
  if (!clean || clean === '.' || clean === '..' || clean.startsWith('../')) {
    throw Object.assign(new Error('Choose a file or folder inside this source'), { status:400 });
  }
  return clean;
}

const compare = value => windows ? String(value).toLowerCase() : String(value);
const contains = (rule, value) => value === rule || value.startsWith(`${rule}/`);

export function sourceRelativePath(root, target) {
  const base = resolve(String(root || ''));
  const raw = String(target || '').trim();
  if (!raw) throw Object.assign(new Error('Choose a file or folder to exclude'), { status:400 });
  const candidate = isAbsolute(raw)
    ? resolve(raw)
    : resolve(base, ...raw.replaceAll('\\', '/').split('/').filter(Boolean));
  const rel = relative(base, candidate).replaceAll('\\', '/');
  if (!rel || rel === '.' || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    throw Object.assign(new Error('Exclusions must be inside the source folder'), { status:400 });
  }
  return cleanRelative(rel);
}

export function sourceExclusions(root) {
  const values = settings.sourceExclusions?.[pathKey(root)];
  return Array.isArray(values) ? values.map(cleanRelative) : [];
}

export function isSourceExcluded(root, target) {
  let rel;
  try {
    const raw = String(target || '');
    rel = isAbsolute(raw) ? sourceRelativePath(root, raw) : cleanRelative(raw);
  } catch {
    return false;
  }
  const key = compare(rel);
  return sourceExclusions(root).some(rule => contains(compare(rule), key));
}

export async function addSourceExclusion(root, target) {
  const key = pathKey(root);
  const rel = sourceRelativePath(root, target);
  const wanted = compare(rel);
  const current = sourceExclusions(root);
  const parent = current.find(rule => contains(compare(rule), wanted));
  if (parent) return { changed:false, path:parent, exclusions:current };

  const next = current
    .filter(rule => !contains(wanted, compare(rule)))
    .concat(rel)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity:windows ? 'base' : 'variant' }));
  settings.sourceExclusions ||= {};
  settings.sourceExclusions[key] = next;
  await persistSettings();
  return { changed:true, path:rel, exclusions:next };
}

export async function removeSourceExclusion(root, target) {
  const key = pathKey(root);
  const rel = cleanRelative(target);
  const wanted = compare(rel);
  const current = sourceExclusions(root);
  const next = current.filter(rule => compare(rule) !== wanted);
  if (next.length === current.length) return { changed:false, exclusions:current };
  if (next.length) settings.sourceExclusions[key] = next;
  else delete settings.sourceExclusions[key];
  await persistSettings();
  return { changed:true, exclusions:next };
}

export async function clearSourceExclusions(root) {
  const key = pathKey(root);
  if (!settings.sourceExclusions?.[key]) return false;
  delete settings.sourceExclusions[key];
  await persistSettings();
  return true;
}

export function exclusionMatchesRelative(root, relativePath) {
  const key = compare(cleanRelative(relativePath));
  return sourceExclusions(root).some(rule => contains(compare(rule), key));
}

export function purgeExcludedIndex(root, indexRoot = pathKey(root)) {
  const rules = sourceExclusions(root).map(compare);
  if (!rules.length) return 0;
  const matches = value => {
    const key = compare(String(value || '').replaceAll('\\', '/').replace(/^\/+/, ''));
    return rules.some(rule => contains(rule, key));
  };

  const db = new DatabaseSync(SYNC_INDEX_PATH, { timeout:5000 });
  const rows = db.prepare('SELECT path FROM file_hashes WHERE root = ?').all(indexRoot).filter(row => matches(row.path));
  const remove = db.prepare('DELETE FROM file_hashes WHERE root = ? AND path = ?');
  try {
    if (rows.length) {
      db.exec('BEGIN IMMEDIATE');
      for (const row of rows) remove.run(indexRoot, row.path);
      db.exec('COMMIT');
    }
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  } finally {
    db.close();
  }

  const meta = new DatabaseSync(`${SYNC_INDEX_PATH}.meta.sqlite`, { timeout:5000 });
  const removeState = meta.prepare('DELETE FROM browse_hash_state WHERE root = ? AND path = ?');
  try {
    if (rows.length) {
      meta.exec('BEGIN IMMEDIATE');
      for (const row of rows) removeState.run(indexRoot, row.path);
      meta.prepare('DELETE FROM preview_meta WHERE root = ?').run(indexRoot);
      meta.exec('COMMIT');
    }
  } catch (error) {
    try { meta.exec('ROLLBACK'); } catch {}
    throw error;
  } finally {
    meta.close();
  }
  return rows.length;
}
