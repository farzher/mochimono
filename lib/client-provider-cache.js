let active = false;
let modulePromise = null;

export function activateClientProviderCache() {
  active = true;
}

export function invalidateClientProviders() {
  if (!active) return;
  modulePromise ||= import('./client-providers.js');
  modulePromise.then(module => module.invalidateClientProviders()).catch(() => {});
}
