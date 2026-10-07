import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { platform } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

function machineIdentity(){
  try{
    let uuid='';
    if(platform()==='win32'){
      const script='$c=Get-CimInstance Win32_ComputerSystem; $p=Get-CimInstance Win32_ComputerSystemProduct; [pscustomobject]@{uuid=$p.UUID;model=$c.Model} | ConvertTo-Json -Compress';
      const value=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',timeout:5000,windowsHide:true,stdio:['ignore','pipe','ignore']}));
      if(/virtual|vmware|vbox|qemu|xen|parallels/i.test(value.model || ''))return '';
      uuid=value.uuid || '';
    }else if(platform()==='linux'){
      if(/virtual|vmware|vbox|qemu|xen|parallels/i.test(readFileSync('/sys/class/dmi/id/product_name','utf8')))return '';
      uuid=readFileSync('/sys/class/dmi/id/product_uuid','utf8').trim();
    }
    if(!/^[a-f0-9-]{32,36}$/i.test(uuid)||/^[0f-]+$/i.test(uuid))return '';
    return `machine:${createHash('sha256').update(uuid.toLowerCase()).digest('hex').slice(0,32)}`;
  }catch{return '';}
}
export const storageMachine = machineIdentity();
let windowsDisks = new Map(), windowsCheckedAt = 0;
const checkedVolumes=new Map();
const unknown = () => ({ machine:'', failureDomain:'' });
const diskIdentity = id => ({ machine:storageMachine, failureDomain:`disk:${createHash('sha256').update(String(id).trim().toLowerCase()).digest('hex').slice(0,32)}` });

function windowsDisk(path) {
  // Filesystem/volume IDs are insufficient: C: and E: can be partitions of
  // the same physical SSD. Query physical disk UniqueId, not drive letters.
  const letter=resolve(path).match(/^([A-Za-z]):/)?.[1]?.toUpperCase();
  if(!letter)return unknown();
  const volume=Number(statSync(path,{bigint:true}).dev);
  if (Date.now()-windowsCheckedAt > 60_000 || (checkedVolumes.get(letter) ?? windowsDisks.get(letter)?.volume)!==volume) {
    windowsCheckedAt = Date.now();
    windowsDisks = new Map();
    const script = '$ErrorActionPreference="Stop"; $volumes=@{}; Get-CimInstance Win32_LogicalDisk | Where-Object VolumeSerialNumber | ForEach-Object { $volumes[$_.DeviceID]=[Convert]::ToUInt32($_.VolumeSerialNumber,16) }; Get-Partition | Where-Object { $_.DriveLetter -and $_.DiskNumber -ne $null } | ForEach-Object { $d=Get-Disk -Number $_.DiskNumber; [pscustomobject]@{letter=[string]$_.DriveLetter;id=$d.UniqueId;bus=[string]$d.BusType;model=$d.FriendlyName;volume=$volumes[([string]$_.DriveLetter+":")]} } | ConvertTo-Json -Compress';
    try {
      const output = JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',timeout:5000,windowsHide:true,stdio:['ignore','pipe','ignore']}));
      for (const disk of Array.isArray(output) ? output : [output]) {
        if (disk?.id?.trim() && ['NVMe','SATA','ATA','SAS','USB'].includes(disk.bus) && !/virtual|vmware|vbox|qemu|amazon elastic block store|logical\s*volume/i.test(disk.model || '')) windowsDisks.set(String(disk.letter).toUpperCase(),{identity:diskIdentity(disk.id),volume:disk.volume});
      }
    } catch { /* Unsupported/unknown storage must not establish independence. */ }
  }
  checkedVolumes.set(letter,volume);
  const disk=windowsDisks.get(letter);
  return disk?.volume===volume ? disk.identity : unknown();
}

function linuxDisk(path) {
  const dev = statSync(path,{bigint:true}).dev;
  const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & ~0xfffn);
  const minor = (dev & 0xffn) | ((dev >> 12n) & ~0xffn);
  let block = realpathSync(`/sys/dev/block/${major}:${minor}`);
  if (existsSync(join(block,'partition'))) block = dirname(block);
  // Device-mapper/RAID backing can overlap other destinations; do not guess.
  if (/^(dm-|md|loop)/.test(basename(block)) || /\/virtual\/|virtio|vmbus|\/session|\/rport/i.test(block)) return unknown();
  try { if(/virtual|vmware|vbox|qemu|amazon elastic block store|logical\s*volume/i.test(readFileSync(join(block,'device/model'),'utf8')))return unknown(); } catch {}
  for (const relative of ['wwid','device/wwid','device/serial','serial']) {
    try {
      const id=readFileSync(join(block,relative),'utf8').trim();
      if(id) return diskIdentity(id);
    } catch {}
  }
  return unknown();
}

export function storageIdentity(path) {
  try {
    if(platform()==='win32')return windowsDisk(path);
    if(platform()==='linux')return linuxDisk(path);
    return unknown();
  } catch { return unknown(); }
}
