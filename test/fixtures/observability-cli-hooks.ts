import { registerHooks } from 'node:module';

registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'baileys' || specifier === 'node:sqlite' || /(?:^|\/)(?:runtime|store|auth)\.js$/.test(specifier)) throw new Error('Forbidden heavy CLI import');
  return next(specifier, context);
} });
