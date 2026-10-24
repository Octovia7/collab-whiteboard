import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      // Allows `const { id: _id, ...rest } = obj` to drop a field.
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true, varsIgnorePattern: '^_', argsIgnorePattern: '^_' }],
    },
  },
  {
    // Plain Node scripts (build, measurements): Node's globals.
    files: ['scripts/**/*.mjs', 'packages/*/build.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly' },
    },
  },
  {
    // CLAUDE.md rule 12: client and server share code only through @whiteboard/shared.
    files: ['packages/client/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['@whiteboard/server', '**/server/**'], message: 'Import from @whiteboard/shared, never from the server.' }] }],
    },
  },
  {
    files: ['packages/server/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['@whiteboard/client', '**/client/**'], message: 'Import from @whiteboard/shared, never from the client.' }] }],
    },
  },
  {
    // CLAUDE.md rule 11: shared runs in plain Node for tests, so no DOM, network or DB code.
    files: ['packages/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'fs', 'path', 'ws', 'pg', 'ioredis', 'drizzle-orm*', 'react*', 'fastify*', '@whiteboard/*'],
              message: 'packages/shared must not import DOM, network, database or app-package code.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'No DOM in shared.' },
        { name: 'document', message: 'No DOM in shared.' },
        { name: 'WebSocket', message: 'No network in shared.' },
        { name: 'fetch', message: 'No network in shared.' },
        { name: 'Date', message: 'Edits are ordered by Lamport stamps, never wall-clock time (CLAUDE.md rule 3).' },
      ],
    },
  },
);
