import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default [
  {
    ignores: [
      '**/node_modules/**',
      // Agent-owned linked worktrees are full repository copies. ESLint does
      // not read ignore files, so without these entries `eslint .` in the main
      // checkout would lint every worktree too.
      '.claude/worktrees/**',
      '.codex/worktrees/**',
    ],
  },
  {
    ...eslint.configs.recommended,
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: globals.node,
    },
  },
  prettier,
];
