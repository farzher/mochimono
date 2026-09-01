import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('.', import.meta.url));
const token = process.env.MOCHIMONO_TOKEN || 'dev';
const serverUrl = 'http://127.0.0.1:8642';
const devData = join(root, 'dev-data');
const devConfigDir = join(devData, '.agent');
const devConfigPath = join(devConfigDir, 'agent.json');
const normalConfigPath = join(homedir(), '.mochimono', 'agent.json');
const children = [];

async function seedDevConfig() {
  if (existsSync(devConfigPath)) return;
  let saved = {};
  try { saved = JSON.parse(await readFile(normalConfigPath, 'utf8')); } catch {}

  const folders = Array.isArray(saved.folders)
    ? saved.folders.map(item => ({
        path: resolve(String(item?.path || item)),
        importId: null,
        lastSynced: null
      })).filter(item => existsSync(item.path))
    : [];
  const browseFolders = Array.isArray(saved.browseFolders)
    ? [...new Set(saved.browseFolders.map(path => resolve(String(path))).filter(existsSync))]
    : [];
  const backups = Array.isArray(saved.backups)
    ? [...new Set(saved.backups.map(path => resolve(String(path))).filter(path => existsSync(join(path, '.mochimono', 'drive.json'))))]
    : [];

  await mkdir(devConfigDir, { recursive: true });
  await writeFile(devConfigPath, `${JSON.stringify({
    device: saved.device,
    uploadWorkers: saved.uploadWorkers,
    folders,
    browseFolders,
    backups
  }, null, 2)}\n`);
}

function run(file, env) {
  const child = spawn(process.execPath, [join(root, file)], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: 'inherit'
  });
  children.push(child);
  child.on('exit', code => {
    if (code && !stopping) {
      console.error(`${file} exited with code ${code}`);
      stop(code);
    }
  });
  return child;
}

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  setTimeout(() => process.exit(code), 100).unref();
}

process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

await seedDevConfig();

console.log('Mochimono local development');
console.log(`Library: ${serverUrl}  (token: ${token})`);
console.log('Agent:   http://127.0.0.1:8643');
console.log(`Data:    ${devData}`);
console.log('');

run('server-entry.js', {
  MOCHIMONO_TOKEN: token,
  MOCHIMONO_DATA: devData,
  HOST: '0.0.0.0',
  PORT: '8642'
});

setTimeout(() => {
  if (!stopping) run('agent-entry.js', {
    MOCHIMONO_TOKEN: token,
    MOCHIMONO_URL: serverUrl,
    MOCHIMONO_CONFIG_DIR: devConfigDir,
    MOCHIMONO_AGENT_PORT: '8643',
    MOCHIMONO_THUMBNAIL_WORKERS: process.env.MOCHIMONO_THUMBNAIL_WORKERS || '1',
    MOCHIMONO_NO_OPEN: '1'
  });
}, 250);