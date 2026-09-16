import { chmod, copyFile, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
  Object.entries(agentDependencies).filter(([name]) => ['sharp','heic-decode','ffmpeg-static'].includes(name))
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

const runtime = join(out, 'runtime');
await mkdir(runtime, { recursive:true });
const executable = process.platform === 'win32' ? 'node.exe' : 'node';
const runtimeNode = join(runtime, executable);
await copyFile(process.execPath, runtimeNode);
if (process.platform !== 'win32') await chmod(runtimeNode, 0o755);

if (target === 'agent') {
  if (process.platform === 'win32') {
    await writeFile(join(out, 'Mochimono.ps1'), `$ErrorActionPreference = 'SilentlyContinue'\n$here = $PSScriptRoot\n$url = 'http://127.0.0.1:8643'\nfunction Ready {\n  try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 "$url/api/health" | Out-Null; return $true } catch { return $false }\n}\nif (-not (Ready)) {\n  Start-Process -WindowStyle Hidden -FilePath "$here\\runtime\\node.exe" -ArgumentList @("$here\\agent-entry.js")\n  for ($i = 0; $i -lt 80 -and -not (Ready); $i++) { Start-Sleep -Milliseconds 250 }\n}\nif (Ready) { Start-Process $url; exit 0 }\nWrite-Error 'Mochimono Agent did not start.'\nexit 1\n`);
    await writeFile(join(out, 'Mochimono.cmd'), `@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0Mochimono.ps1"\r\n`);
  } else {
    await writeFile(join(out, 'mochimono'), `#!/bin/sh\nset -eu\nHERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexec "$HERE/runtime/node" "$HERE/agent-entry.js"\n`, { mode:0o755 });
  }
}

await writeFile(join(out, 'RELEASE.txt'), [
  `Mochimono ${target} ${sourcePackage.version}`,
  `Built with ${process.version} for ${process.platform}-${process.arch}.`,
  target === 'agent'
    ? 'This directory is portable. Keep all files together. User data is stored outside this directory in the normal Mochimono config location.'
    : 'This directory includes its Node runtime. Set MOCHIMONO_TOKEN and MOCHIMONO_DATA before starting it behind a reverse proxy.'
].join('\n') + '\n');

console.log(`Release ready: ${out}`);
