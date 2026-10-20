import { registerHooks } from 'node:module';

// Only explicitly opted-in test children use this fictional connection.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === './runtime.js' &&
      ['daemon', 'probe'].some(
        (entry) =>
          context.parentURL ===
          new URL(`../../src/${entry}.js`, import.meta.url).href,
      )
    ) {
      return {
        url: new URL('./error-runtime.js', import.meta.url).href,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});
