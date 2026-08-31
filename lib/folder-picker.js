import { spawn } from 'node:child_process';
import { platform } from 'node:os';

function commandOutput(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `Folder picker exited with code ${code}`)));
  });
}

export async function pickFolder() {
  if (platform() === 'win32') {
    const script = "Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description='Choose a folder for Mochimono'; if($d.ShowDialog() -eq 'OK'){[Console]::Out.Write($d.SelectedPath)}";
    return await commandOutput('powershell.exe', ['-NoProfile', '-STA', '-Command', script]) || null;
  }
  if (platform() === 'darwin') {
    try { return await commandOutput('osascript', ['-e', 'POSIX path of (choose folder with prompt "Choose a folder for Mochimono")']) || null; }
    catch { return null; }
  }
  try { return await commandOutput('zenity', ['--file-selection', '--directory', '--title=Choose a folder for Mochimono']) || null; }
  catch { throw new Error('Native folder picker is unavailable. Paste the folder path instead.'); }
}
