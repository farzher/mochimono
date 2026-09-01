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

async function windowsFolderPicker(title, multiple) {
  const safeTitle = powershellString(title);
  const script = `
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class MochimonoFolderPicker {
  const uint FOS_PICKFOLDERS = 0x00000020;
  const uint FOS_FORCEFILESYSTEM = 0x00000040;
  const uint FOS_ALLOWMULTISELECT = 0x00000200;
  const uint SIGDN_FILESYSPATH = 0x80058000;

  // Declare the complete IFileOpenDialog vtable directly. COM interop does not
  // reliably append inherited interface methods when a hand-written ComImport
  // interface derives from IFileDialog; GetResults can otherwise land on the
  // wrong slot and throw E_INVALIDARG after a valid multi-selection.
  [ComImport]
  [Guid("d57c7288-d4ad-4768-be02-9d969532d960")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileOpenDialog {
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
    void GetResults(out IShellItemArray ppenum);
    void GetSelectedItems(out IShellItemArray ppsai);
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

  [ComImport]
  [Guid("b63ea76d-1f85-456f-a19c-48159efa858b")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItemArray {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppvOut);
    void GetPropertyStore(int flags, ref Guid riid, out IntPtr ppv);
    void GetPropertyDescriptionList(IntPtr keyType, ref Guid riid, out IntPtr ppv);
    void GetAttributes(uint flags, uint mask, out uint attributes);
    void GetCount(out uint count);
    void GetItemAt(uint index, out IShellItem item);
    void EnumItems(out IntPtr enumShellItems);
  }

  static string PathFor(IShellItem item) {
    IntPtr pathPointer;
    item.GetDisplayName(SIGDN_FILESYSPATH, out pathPointer);
    try { return Marshal.PtrToStringUni(pathPointer); }
    finally { Marshal.FreeCoTaskMem(pathPointer); }
  }

  public static string[] Pick(string title, bool multiple) {
    IFileOpenDialog dialog = null;
    try {
      var type = Type.GetTypeFromCLSID(new Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7"));
      dialog = (IFileOpenDialog)Activator.CreateInstance(type);

      // Folder-mode multi-select is supported natively. Keep this to the
      // minimal folder-picker flags used by established native implementations;
      // FILEMUSTEXIST/PATHMUSTEXIST can make Explorer validate the quoted names
      // from a multi-selection as if they were one typed filename.
      uint options = FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM;
      if (multiple) options |= FOS_ALLOWMULTISELECT;
      dialog.SetOptions(options);
      dialog.SetTitle(title);
      dialog.SetOkButtonLabel(multiple ? "Select folders" : "Select folder");
      if (dialog.Show(IntPtr.Zero) != 0) return new string[0];

      var paths = new List<string>();
      if (multiple) {
        IShellItemArray items = null;
        try {
          dialog.GetResults(out items);
          uint count;
          items.GetCount(out count);
          for (uint i = 0; i < count; i++) {
            IShellItem item = null;
            try {
              items.GetItemAt(i, out item);
              var path = PathFor(item);
              if (!String.IsNullOrWhiteSpace(path)) paths.Add(path);
            } finally {
              if (item != null) Marshal.ReleaseComObject(item);
            }
          }
        } finally {
          if (items != null) Marshal.ReleaseComObject(items);
        }
      } else {
        IShellItem item = null;
        try {
          dialog.GetResult(out item);
          var path = PathFor(item);
          if (!String.IsNullOrWhiteSpace(path)) paths.Add(path);
        } finally {
          if (item != null) Marshal.ReleaseComObject(item);
        }
      }
      return paths.ToArray();
    } finally {
      if (dialog != null) Marshal.ReleaseComObject(dialog);
    }
  }
}
'@
$paths = [MochimonoFolderPicker]::Pick('${safeTitle}', $${multiple ? 'true' : 'false'})
if ($paths) { [Console]::Out.Write((ConvertTo-Json -InputObject @($paths) -Compress)) }
`;
  const output = await commandOutput('powershell.exe', ['-NoProfile', '-STA', '-Command', script]);
  if (!output) return [];
  try {
    const parsed = JSON.parse(output);
    return (Array.isArray(parsed) ? parsed : [parsed]).map(String).filter(Boolean);
  } catch {
    return output.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  }
}

async function macFolderPicker(title, multiple) {
  if (!multiple) {
    const output = await commandOutput('osascript', ['-e', `POSIX path of (choose folder with prompt "${appleScriptString(title)}")`]);
    return output ? [output] : [];
  }
  const script = `set picked to choose folder with prompt "${appleScriptString(title)}" with multiple selections allowed\nset output to ""\nrepeat with itemRef in picked\nset output to output & (POSIX path of itemRef) & linefeed\nend repeat\nreturn output`;
  const output = await commandOutput('osascript', ['-e', script]);
  return output.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
}

async function linuxFolderPicker(title, multiple) {
  const args = ['--file-selection', '--directory', `--title=${title}`];
  if (multiple) args.push('--multiple', '--separator=\n');
  const output = await commandOutput('zenity', args);
  return output.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
}

export async function pickFolder({ title = 'Choose a folder for Mochimono', multiple = false } = {}) {
  title = String(title || 'Choose a folder for Mochimono').slice(0, 160);
  let paths;
  if (platform() === 'win32') paths = await windowsFolderPicker(title, multiple);
  else if (platform() === 'darwin') {
    try { paths = await macFolderPicker(title, multiple); }
    catch { paths = []; }
  } else {
    try { paths = await linuxFolderPicker(title, multiple); }
    catch { throw new Error('Native folder picker is unavailable. Paste the folder path instead.'); }
  }
  return multiple ? paths : paths[0] || null;
}