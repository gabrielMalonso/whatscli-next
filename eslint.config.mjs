import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores([
    '**/.git/**',
    '**/node_modules/**',
    '**/dist/**',
    '**/.private/**',
    '**/.tmp/**',
    '**/auth_info*/**',
    '**/credentials/**',
    '**/sessions/**',
    '**/state/**',
    '**/media/**',
    '**/backups/**',
    '**/*.sqlite*',
    '**/*.db*',
    '**/*.log',
    '**/.env*',
    '**/creds.json',
    '**/credentials.json',
  ]),
  {
    files: ['eslint.config.mjs'],
    extends: [js.configs.recommended],
  },
  {
    files: ['src/**/*.ts', 'scripts/**/*.ts', 'test/**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    rules: {
      // Injected arguments and object-rest omissions are intentional in I/O fixtures.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
);
