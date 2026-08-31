import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, extname, join, relative, resolve } from 'node:path';

const originalOpendir = fs.promises.opendir.bind(fs.promises);
const originalWatch = fs.watch.bind(fs);
const originalSpawn = childProcess.spawn.bind(childProcess);
const gitRootCache = new Map();

const ALWAYS_IGNORED_DIRS = new Set(['.git', '.mochimono', 'node_modules']);
const GENERATED_DIRS = new Set([
  '.cache', '.gradle', '.mypy_cache', '.next', '.nuxt', '.parcel-cache', '.pytest_cache', '.ruff_cache',
  '.svelte-kit', '.tox', '.turbo', '.venv', '__pycache__', 'bin', 'build', 'coverage', 'dist', 'obj', 'out',
  'target', 'venv'
]);
const GENERATED_EXTENSIONS = new Set(['.class', '.ilk', '.log', '.o', '.obj', '.pyc', '.pyo', '.temp', '.tmp']);
const GENERATED_FILES = new Set(['.ds_store', 'thumbs.db']);

function pathKey(path) {
  return process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
}

function gitRoot(path) {
  const start = resolve(path);
  const cached = gitRootCache.get(pathKey(start));
  if (cached !== undefined) return cached;
  let current = start;
  while (true) {
    if (fs.existsSync(join(current, '.git'))) {
      gitRootCache.set(pathKey(start), current);
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  gitRootCache.set(pathKey(start), null);
  return null;
}

function parts(path) {
  return String(path || '').replaceAll('\\', '/').split('/').filter(Boolean);
}

function alwaysIgnored(path) {
  return parts(path).some(part => ALWAYS_IGNORED_DIRS.has(part.toLowerCase()));
}

function generatedCandidate(path) {
  const names = parts(path).map(part => part.toLowerCase());
  if (names.some(part => GENERATED_DIRS.has(part))) return true;
  const name = names.at(-1) || '';
  return GENERATED_FILES.has(name) || GENERATED_EXTENSIONS.has(extname(name));
}

function gitPath(root, path) {
  return relative(root, resolve(path)).replaceAll('\\', '/');
}

function gitIgnored(root, paths) {
  const clean = [...new Set(paths.map(path => gitPath(root, path)).filter(path => path && !path.startsWith('../')))];
  if (!clean.length) return Promise.resolve(new Set());
  return new Promise(resolvePromise => {
    const child = originalSpawn('git', ['-C', root, 'check-ignore', '-z', '--stdin'], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore']
    });
    const chunks = [];
    let settled = false;
    const finish = ignored => {
      if (settled) return;
      settled = true;
      resolvePromise(ignored);
    };
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.on('error', () => finish(new Set()));
    child.on('close', code => {
      if (code !== 0 && code !== 1) return finish(new Set());
      finish(new Set(Buffer.concat(chunks).toString('utf8').split('\0').filter(Boolean)));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(`${clean.join('\0')}\0`);
  });
}

function ignoredByDevelopmentRules(root, absolute, ignored) {
  const rel = gitPath(root, absolute);
  return alwaysIgnored(rel) || (generatedCandidate(rel) && ignored.has(rel));
}

fs.promises.opendir = async function filteredOpendir(directory, options) {
  const dir = await originalOpendir(directory, options);
  const entries = [];
  for await (const entry of dir) entries.push(entry);

  const root = gitRoot(directory);
  if (!root) {
    const visible = entries.filter(entry => !alwaysIgnored(entry.name));
    return { async *[Symbol.asyncIterator]() { yield* visible; } };
  }

  const childPaths = entries.map(entry => join(directory, entry.name));
  const ignored = await gitIgnored(root, childPaths);
  const visible = entries.filter((entry, index) => !ignoredByDevelopmentRules(root, childPaths[index], ignored));
  return { async *[Symbol.asyncIterator]() { yield* visible; } };
};

fs.watch = function filteredWatch(path, options, listener) {
  if (typeof options === 'function') {
    listener = options;
    options = undefined;
  }
  if (typeof listener !== 'function') return originalWatch(path, options);

  const base = resolve(path);
  const root = gitRoot(base);
  if (!root) return originalWatch(base, options, (event, filename) => {
    if (filename != null && alwaysIgnored(String(filename))) return;
    listener(event, filename);
  });

  const pending = new Map();
  let timer = null;
  const flush = async () => {
    timer = null;
    const batch = [...pending.entries()];
    pending.clear();
    if (!batch.length) return;
    const paths = batch.map(([, filename]) => join(base, filename));
    const ignored = await gitIgnored(root, paths);
    for (let index = 0; index < batch.length; index++) {
      const [event, filename] = batch[index];
      if (ignoredByDevelopmentRules(root, paths[index], ignored)) continue;
      if (parts(filename).at(-1)?.toLowerCase() === '.gitignore') listener(event, null);
      else listener(event, filename);
    }
  };

  return originalWatch(base, options, (event, filename) => {
    if (filename == null) return listener(event, filename);
    const value = String(filename);
    if (alwaysIgnored(value)) return;
    pending.set(value, [event, value]);
    clearTimeout(timer);
    timer = setTimeout(flush, 100);
  });
};

childProcess.spawn = function patchedSpawn(command, args, options) {
  const fixed = Array.isArray(args) ? args.map(arg => arg === '0:V:0' ? '0:v:0' : arg) : args;
  return originalSpawn(command, fixed, options);
};

syncBuiltinESMExports();
