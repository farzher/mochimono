import { isAbsolute, relative, resolve } from 'node:path';
import { platform } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { pathKey, persistSettings, settings, SYNC_INDEX_PATH } from './agent-context.js';

const windows = platform() === 'win32';
const globCache = new Map();

function cleanRelative(value) {
  const parts = String(value || '')
    .replaceAll('\\', '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .split('/')
    .filter(Boolean);
  if (!parts.length || parts.some(part => part === '.' || part === '..')) {
    throw Object.assign(new Error('Choose a file or folder inside this source'), { status:400 });
  }
  return parts.join('/');
}

const compare = value => windows ? String(value).toLowerCase() : String(value);
const contains = (rule, value) => value === rule || value.startsWith(`${rule}/`);
const hasGlob = value => /[*?]/.test(String(value));
const escapeRegex = value => value.replace(/[.+^${}()|[\]\\]/g, '\\$&');

function globRegex(rule) {
  const key = compare(rule);
  if (globCache.has(key)) return globCache.get(key);
  let source = '^';
  for (let i = 0; i < key.length;) {
    if (key[i] === '*' && key[i + 1] === '*' && key[i + 2] === '/') {
      source += '(?:[^/]+/)*';
      i += 3;
      continue;
    }
    if (key[i] === '/' && key[i + 1] === '*' && key[i + 2] === '*' && i + 3 === key.length) {
      source += '(?:/.*)?';
      i += 3;
      continue;
    }
    if (key[i] === '*' && key[i + 1] === '*') {
      source += '.*';
      i += 2;
      continue;
    }
    if (key[i] === '*') source += '[^/]*';
    else if (key[i] === '?') source += '[^/]';
    else source += escapeRegex(key[i]);
    i++;
  }
  const regex = new RegExp(`${source}$`);
  globCache.set(key, regex);
  return regex;
}

function matchesRule(rule, relativePath) {
  const pattern = compare(rule);
  const path = compare(relativePath);
  if (!hasGlob(pattern)) return contains(pattern, path);
  const regex = globRegex(pattern);
  if (regex.test(path)) return true;
  let slash = path.length;
  while ((slash = path.lastIndexOf('/', slash - 1)) >= 0) {
    if (regex.test(path.slice(0, slash))) return true;
  }
  return false;
}

export function sourceRelativePath(root, target) {
  const base = resolve(String(root || ''));
  const raw = String(target || '').trim();
  if (!raw) throw Object.assign(new Error('Choose a file, folder, or pattern to exclude'), { status:400 });
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
  return sourceExclusions(root).some(rule => matchesRule(rule, rel));
}

export async function addSourceExclusion(root, target) {
  const key = pathKey(root);
  const rel = sourceRelativePath(root, target);
  const current = sourceExclusions(root);
  const wanted = compare(rel);
  const existing = current.find(rule => compare(rule) === wanted || matchesRule(rule, rel));
  if (existing) return { changed:false, path:existing, exclusions:current };

  const next = current
    .filter(rule => hasGlob(rel) || hasGlob(rule) || !contains(wanted, compare(rule)))
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
  const path = cleanRelative(relativePath);
  return sourceExclusions(root).some(rule => matchesRule(rule, path));
}

export function purgeExcludedIndex(root, indexRoot = pathKey(root)) {
  const rules = sourceExclusions(root);
  if (!rules.length) return 0;
  const matches = value => {
    try { return rules.some(rule => matchesRule(rule, cleanRelative(value))); }
    catch { return false; }
  };

  const db = new DatabaseSync(SYNC_INDEX_PATH, { timeout:5000 });
  const rows = db.prepare('SELECT path FROM files WHERE root = ?').all(indexRoot).filter(row => matches(row.path));
  const remove = db.prepare('DELETE FROM files WHERE root = ? AND path = ?');
  try {
    if (rows.length) {
      db.exec('BEGIN IMMEDIATE');
      for (const row of rows) remove.run(indexRoot, row.path);
      db.prepare("UPDATE root_meta SET previewed_at='' WHERE root = ?").run(indexRoot);
      db.exec('COMMIT');
    }
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  } finally {
    db.close();
  }
  return rows.length;
}
