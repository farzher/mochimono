import { copyFile, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIST = join(ROOT, 'dist');
const target = String(process.argv[2] || '').toLowerCase();
if (!['agent','server'].includes(target)) {
  console.error('Usage: node scripts/build-release.js <agent|server>');
  process.exit(1);
}

const sourcePackage = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
const out = join(DIST, target);
await rm(out, { recursive:true, force:true });
await mkdir(out, { recursive:true });

const skip = new Set(['.git', '.github', 'data', 'dist', 'node_modules', 'scripts']);
if (target === 'server') skip.add('agent-web');
for (const entry of await readdir(ROOT, { withFileTypes:true })) {
  if (skip.has(entry.name)) continue;
  const source = join(ROOT, entry.name);
  const destination = join(out, entry.name);
  if (entry.isDirectory()) await cp(source, destination, { recursive:true });
  else if (entry.isFile()) await copyFile(source, destination);
}

const agentDependencies = sourcePackage.dependencies || {};
const serverDependencies = Object.fromEntries(
  Object.entries(agentDependencies).filter(([name]) => ['sharp','heic-decode'].includes(name))
);
const releasePackage = {
  name:`mochimono-${target}`,
  version:sourcePackage.version,
  private:true,
  type:'module',
  engines:sourcePackage.engines,
  scripts:target === 'agent'
    ? { start:'node agent-entry.js' }
    : { start:'node server-entry.js' },
  dependencies:target === 'agent' ? agentDependencies : serverDependencies
};
await writeFile(join(out, 'package.json'), `${JSON.stringify(releasePackage, null, 2)}\n`);
await rm(join(out, 'package-lock.json'), { force:true });
await rm(join(out, 'ensure-deps.js'), { force:true });

async function run(command, args, cwd) {
  const windows = process.platform === 'win32';
  const exe = windows && command === 'npm' ? (process.env.ComSpec || 'cmd.exe') : command;
  const finalArgs = windows && command === 'npm'
    ? ['/d','/s','/c',`npm.cmd ${args.join(' ')}`]
    : args;
  const code = await new Promise((resolvePromise, reject) => {
    const child = spawn(exe, finalArgs, { cwd, stdio:'inherit', windowsHide:true });
    child.once('error', reject);
    child.once('close', resolvePromise);
  });
  if (code) throw new Error(`${command} exited with ${code}`);
}

console.log(`Installing ${target} runtime dependencies...`);
await run('npm', ['install','--omit=dev','--no-audit','--no-fund','--package-lock=false'], out);

if (target === 'agent') {
  const runtime = join(out, 'runtime');
  await mkdir(runtime, { recursive:true });
  const executable = process.platform === 'win32' ? 'node.exe' : 'node';
  await copyFile(process.execPath, join(runtime, executable));

  if (process.platform === 'win32') {
    await writeFile(join(out, 'Mochimono.cmd'), `@echo off\r\nsetlocal\r\ncd /d "%~dp0"\r\nstart "Mochimono Agent" /min "%~dp0runtime\\node.exe" "%~dp0agent-entry.js"\r\npowershell -NoProfile -WindowStyle Hidden -Command "$u='http://127.0.0.1:8643'; for($i=0;$i -lt 80;$i++){try{Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 $u/api/health ^| Out-Null; Start-Process $u; exit 0}catch{}; Start-Sleep -Milliseconds 250}; exit 1"\r\n`);
  } else {
    await writeFile(join(out, 'mochimono'), `#!/bin/sh\nset -eu\nHERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexec "$HERE/runtime/node" "$HERE/agent-entry.js"\n`, { mode:0o755 });
  }
}

await writeFile(join(out, 'RELEASE.txt'), [
  `Mochimono ${target} ${sourcePackage.version}`,
  `Built with ${process.version} for ${process.platform}-${process.arch}.`,
  target === 'agent'
    ? 'This directory is portable. Keep all files together. User data is stored outside this directory in the normal Mochimono config location.'
    : 'Set MOCHIMONO_TOKEN and MOCHIMONO_DATA before starting. Run behind a reverse proxy; the default bind address is localhost.'
].join('\n') + '\n');

console.log(`Release ready: ${out}`);
