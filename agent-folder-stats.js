import { readFile, statfs } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';

const CONFIG_PATH = join(homedir(), '.mochimono', 'agent.json');
const INDEX_PATH = join(homedir(), '.mochimono', 'index.sqlite');
let db;

const keyFor = path => platform() === 'win32' ? resolve(path).toLowerCase() : resolve(path);

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  res.end(body);
}

async function filesystem(path) {
  try {
    const fs = await statfs(path);
    return {
      capacityBytes: Number(fs.blocks) * Number(fs.bsize),
      freeBytes: Number(fs.bavail) * Number(fs.bsize)
    };
  } catch {
    return { capacityBytes: 0, freeBytes: 0 };
  }
}

async function folderStats() {
  let saved = {};
  try { saved = JSON.parse(await readFile(CONFIG_PATH, 'utf8')); } catch {}
  const folders = Array.isArray(saved.folders) ? saved.folders : [];
  if (!folders.length) return [];

  try {
    db ||= new DatabaseSync(INDEX_PATH, { timeout: 5000 });
    const stats = db.prepare('SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM file_hashes WHERE root = ?');
    return await Promise.all(folders.map(async item => {
      const path = resolve(String(item?.path || item));
      const row = stats.get(keyFor(path));
      return {
        path,
        files: Number(row?.files) || 0,
        bytes: Number(row?.bytes) || 0,
        ...await filesystem(path)
      };
    }));
  } catch {
    return Promise.all(folders.map(async item => {
      const path = resolve(String(item?.path || item));
      return { path, files: 0, bytes: 0, ...await filesystem(path) };
    }));
  }
}

const originalCreateServer = http.createServer;
http.createServer = function (...args) {
  const context = this;
  http.createServer = originalCreateServer;
  const index = args.findIndex(value => typeof value === 'function');
  if (index < 0) return originalCreateServer.apply(context, args);
  const listener = args[index];
  args[index] = async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/api/folder-stats') {
      return json(res, 200, { folders: await folderStats() });
    }
    return listener(req, res);
  };
  return originalCreateServer.apply(context, args);
};