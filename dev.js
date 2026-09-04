import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('.', import.meta.url));
const token = process.env.MOCHIMONO_TOKEN || 'dev';
const serverUrl = 'http://127.0.0.1:8642';
const devData = join(root, 'dev-data');
const devConfigDir = join(devData, '.agent');
const children = [];

function exitDescription(code, signal) {
  if (signal) return `signal ${signal}`;
  if (!Number.isInteger(code)) return String(code);
  if (process.platform !== 'win32') return String(code);
  return `${code} (0x${(code >>> 0).toString(16).padStart(8, '0')})`;
}

function run(file, env) {
  const child = spawn(process.execPath, [join(root, file)], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: 'inherit'
  });
  children.push(child);
  child.on('exit', (code, signal) => {
    if ((code || signal) && !stopping) {
      console.error(`${file} exited with ${exitDescription(code, signal)}`);
      stop(code || 1);
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
    MOCHIMONO_NO_OPEN: '1'
  });
}, 250);
