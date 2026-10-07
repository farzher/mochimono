// Used by protection planning and destructive-action checks. Smaller media
// copies remain visible but never satisfy an Original protection goal.
export const BACKUP_TARGETS = {
  disposable: { copies:1, devices:1, remote:0, sites:0, managed:0 },
  normal: { copies:2, devices:2, remote:0, sites:0, managed:1 },
  important: { copies:3, devices:3, remote:1, sites:2, managed:1 },
  critical: { copies:3, devices:3, remote:1, sites:2, managed:1 }
};

export function evaluateBackup(target, copies = []) {
  const verified = copies.filter(copy => copy.verified && copy.reliability !== 'low' && (!copy.encrypted || copy.recoveryReady === true));
  const originals = verified.filter(copy => copy.representation !== 'compact');
  // Known physical disks remain independent even when their place is unknown.
  // Distinct explicitly confirmed physical places also prove independence, but
  // unidentified storage in one place never adds another slot there by itself.
  const placed=new Map();
  const confirmed=copy=>new Date(copy.placementConfirmedAt || copy.lastSeen || copy.verifiedAt || 0).getTime() || 0;
  for(const copy of originals){
    const id=copy.failureDomain;
    if(id&&(!placed.has(id)||confirmed(copy)>confirmed(placed.get(id))))placed.set(id,copy);
  }
  const placeOf=copy=>String(copy.place || '').trim().replace(/\s+/g,' ').toLowerCase();
  const knownPlaces=new Map();
  const unplaced=[];
  for(const [id,copy] of placed){if(placeOf(copy))knownPlaces.set(placeOf(copy),id);else unplaced.push(id);}
  const aliases=new Map(knownPlaces);
  const unidentifiedPlaces=[...new Set(originals.filter(copy=>!copy.failureDomain&&placeOf(copy)&&!knownPlaces.has(placeOf(copy))).map(placeOf))].sort();
  unidentifiedPlaces.forEach((place,index)=>aliases.set(place,unplaced[index] || `place:${place}`));
  const domain=copy=>copy.failureDomain || aliases.get(placeOf(copy)) || '';
  const domains = new Set(originals.map(domain).filter(Boolean));
  const places = new Set([...placed.values()].map(placeOf).concat(originals.filter(copy=>!copy.failureDomain).map(placeOf)).filter(Boolean));
  const managedPlaces=new Set(originals.filter(copy=>copy.kind!=='source'&&placeOf(copy)&&(!copy.failureDomain||placeOf(copy)===placeOf(placed.get(copy.failureDomain)))).map(placeOf));
  const references=(target.referencePlaces || []).map(place=>placeOf({place}));
  const offsite=references.length&&references.every(Boolean)
    ? references.every(place=>[...managedPlaces].some(other=>other!==place))
    : managedPlaces.size>=2;
  const qualifying=domains.size || (target.copies===1&&originals.length ? 1 : 0);
  const status = {
    copies:copies.length,
    verified:copies.filter(copy => copy.verified).length,
    qualifyingCopies:qualifying,
    originals:originals.length,
    reducedFidelity:verified.filter(copy => copy.representation === 'compact').length,
    devices:qualifying,
    sites:places.size,
    remote:offsite ? 1 : 0,
    managed:originals.filter(copy => copy.kind !== 'source').length,
    unknownStorage:originals.filter(copy => !copy.failureDomain).length,
    unsavedKeys:copies.filter(copy => copy.encrypted && copy.recoveryReady !== true).length
  };
  const missing = {
    copies:Math.max(0, target.copies - qualifying),
    originals:Math.max(0, target.copies - qualifying),
    devices:Math.max(0, target.devices - qualifying),
    remote:Math.max(0, target.remote - status.remote),
    sites:Math.max(0, target.sites - places.size),
    managed:Math.max(0, target.managed - status.managed)
  };
  return { target, status, missing, meets:Object.values(missing).every(value => value === 0) };
}
