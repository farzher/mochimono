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

function powershellString(value) {
  return String(value || '').replaceAll("'", "''");
}

function appleScriptString(value) {
  return String(value || '').replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

async function windowsFolderPicker(title) {
  const safeTitle = powershellString(title);
  const script = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class MochimonoFolderPicker {
  const uint FOS_PICKFOLDERS = 0x00000020;
  const uint FOS_FORCEFILESYSTEM = 0x00000040;
  const uint FOS_PATHMUSTEXIST = 0x00000800;
  const uint SIGDN_FILESYSPATH = 0x80058000;

  [ComImport]
  [Guid("42f85136-db7e-439c-85f1-e4075d135fc8")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileDialog {
    [PreserveSig] int Show(IntPtr hwndOwner);
    void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
    void SetFileTypeIndex(uint iFileType);
    void GetFileTypeIndex(out uint piFileType);
    void Advise(IntPtr pfde, out uint pdwCookie);
    void Unadvise(uint dwCookie);
    void SetOptions(uint fos);
    void GetOptions(out uint fos);
    void SetDefaultFolder(IShellItem psi);
    void SetFolder(IShellItem psi);
    void GetFolder(out IShellItem ppsi);
    void GetCurrentSelection(out IShellItem ppsi);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
    void GetResult(out IShellItem ppsi);
    void AddPlace(IShellItem psi, uint fdap);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
    void Close(int hr);
    void SetClientGuid(ref Guid guid);
    void ClearClientData();
    void SetFilter(IntPtr pFilter);
  }

  [ComImport]
  [Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdnName, out IntPtr ppszName);
    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    void Compare(IShellItem psi, uint hint, out int piOrder);
  }

  public static string Pick(string title) {
    IFileDialog dialog = null;
    IShellItem item = null;
    try {
      var type = Type.GetTypeFromCLSID(new Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7"));
      dialog = (IFileDialog)Activator.CreateInstance(type);
      uint options;
      dialog.GetOptions(out options);
      dialog.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
      dialog.SetTitle(title);
      dialog.SetOkButtonLabel("Select folder");
      if (dialog.Show(IntPtr.Zero) != 0) return null;
      dialog.GetResult(out item);
      IntPtr pathPointer;
      item.GetDisplayName(SIGDN_FILESYSPATH, out pathPointer);
      try { return Marshal.PtrToStringUni(pathPointer); }
      finally { Marshal.FreeCoTaskMem(pathPointer); }
    } finally {
      if (item != null) Marshal.ReleaseComObject(item);
      if (dialog != null) Marshal.ReleaseComObject(dialog);
    }
  }
}
'@
$path = [MochimonoFolderPicker]::Pick('${safeTitle}')
if ($path) { [Console]::Out.Write($path) }
`;
  return await commandOutput('powershell.exe', ['-NoProfile', '-STA', '-Command', script]) || null;
}

export async function pickFolder({ title = 'Choose a folder for Mochimono' } = {}) {
  title = String(title || 'Choose a folder for Mochimono').slice(0, 160);
  if (platform() === 'win32') return windowsFolderPicker(title);
  if (platform() === 'darwin') {
    try {
      return await commandOutput('osascript', ['-e', `POSIX path of (choose folder with prompt "${appleScriptString(title)}")`]) || null;
    } catch { return null; }
  }
  try { return await commandOutput('zenity', ['--file-selection', '--directory', `--title=${title}`]) || null; }
  catch { throw new Error('Native folder picker is unavailable. Paste the folder path instead.'); }
}
