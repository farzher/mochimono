import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('.', import.meta.url));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const missing = [];

for (const [name, wanted] of Object.entries(pkg.dependencies || {})) {
  try {
    const installed = JSON.parse(await readFile(join(root, 'node_modules', name, 'package.json'), 'utf8'));
    if (installed.version !== wanted) missing.push(`${name}@${wanted}`);
  } catch {
    missing.push(`${name}@${wanted}`);
  }
}

if (missing.length) {
  console.log(`Installing Mochimono dependencies: ${missing.join(', ')}`);
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const code = await new Promise((resolve, reject) => {
    const child = spawn(command, ['install', '--no-audit', '--no-fund', '--prefer-offline'], {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true
    });
    child.on('error', reject);
    child.on('close', resolve);
  });
  if (code !== 0) process.exit(code || 1);
}
