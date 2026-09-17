let modulePromise = null;

export async function handleClientProviderApi(...args) {
  modulePromise ||= import('./client-providers.js');
  return (await modulePromise).handleClientProviderApi(...args);
}
