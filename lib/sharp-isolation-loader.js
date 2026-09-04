const provider = new URL('./provider-thumbs.js', import.meta.url).href;
const proxy = new URL('./sharp-provider-proxy.js', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'sharp' && context.parentURL === provider) {
    return { url: proxy, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
