import { registerHooks } from 'node:module';

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === './runtime.js' && context.parentURL === new URL('../../src/daemon.js', import.meta.url).href) {
    return { url: new URL('./backup-runtime.js', import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
} });
