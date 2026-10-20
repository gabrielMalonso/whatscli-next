import { registerHooks } from 'node:module';

// Only this child daemon receives the fictional socket; CLI processes run unchanged.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === './runtime.js' &&
      context.parentURL === new URL('../../src/daemon.js', import.meta.url).href
    ) {
      return {
        url: new URL('./delayed-runtime.js', import.meta.url).href,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});
