import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const token = process.env.MOCHIMONO_TOKEN || 'dev';
const serverUrl = 'http://127.0.0.1:8642';
const children = [];

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

console.log('Mochimono local development');
console.log(`Library: ${serverUrl}  (token: ${token})`);
console.log('Agent:   http://127.0.0.1:8643');
console.log(`Data:    ${join(root, 'dev-data')}`);
console.log('');

run('server-entry.js', {
  MOCHIMONO_TOKEN: token,
  MOCHIMONO_DATA: join(root, 'dev-data'),
  HOST: '0.0.0.0',
  PORT: '8642'
});

setTimeout(() => {
  if (!stopping) run('agent-entry.js', {
    MOCHIMONO_TOKEN: token,
    MOCHIMONO_URL: serverUrl,
    MOCHIMONO_AGENT_PORT: '8643'
  });
}, 250);
