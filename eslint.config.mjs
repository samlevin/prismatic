import { fileURLToPath } from 'node:url';
import eslint from '@eslint/js';
import markdown from '@eslint/markdown';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import boundaries from './tooling/eslint/importBoundaries.ts';

const javascriptFiles = ['**/*.{js,mjs,cjs}'];
const typescriptFiles = ['**/*.ts'];
const codeFiles = [...javascriptFiles, ...typescriptFiles];

export default [
  {
    ignores: [
      '**/node_modules/**',
      // Agent-owned linked worktrees are full repository copies. ESLint does
      // not read ignore files, so without these entries `eslint .` in the main
      // checkout would lint every worktree too.
      '.claude/worktrees/**',
      '.codex/worktrees/**',
      // Untracked personal agent instructions, such as CLAUDE.local.md.
      '**/*.local.md',
      '**/AGENTS.override.md',
      // Build and coverage output.
      'coverage/**',
      'dist/**',
      // Deliberate violations that tests lint on purpose.
      'tooling/eslint/fixtures/**',
    ],
  },
  {
    ...eslint.configs.recommended,
    files: codeFiles,
    languageOptions: {
      globals: globals.node,
    },
  },
  // typescript-eslint's recommended rules, limited to TypeScript so they
  // never reach JavaScript or Markdown.
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: typescriptFiles,
  })),
  // Import boundaries between src/ modules and apps/, for production files
  // only. Tests beside the source may import test tooling.
  {
    files: ['src/**/*.ts', 'apps/**/*.ts'],
    ignores: ['**/*.test.ts'],
    plugins: { boundaries },
    rules: {
      'boundaries/imports': [
        'error',
        {
          root: fileURLToPath(new URL('.', import.meta.url)),
          packages: [],
          exceptions: [
            // The Action entrypoint opens GITHUB_OUTPUT and
            // GITHUB_STEP_SUMMARY as root and creates the run's workspace
            // after the privilege drop. Until ActionBootstrap exists, its
            // stub also starts the first git process.
            {
              file: 'apps/action/main.ts',
              imports: ['node:fs', 'node:child_process'],
            },
          ],
        },
      ],
    },
  },
  // Outside the adapters, production code also may not reach the network,
  // the filesystem, or native code through globals that need no import.
  {
    files: ['src/**/*.ts', 'apps/**/*.ts'],
    ignores: [
      '**/*.test.ts',
      'src/github/**',
      'src/repository/**',
      'src/model/**',
    ],
    rules: {
      'no-restricted-globals': [
        'error',
        ...['fetch', 'WebSocket', 'EventSource'].map((name) => ({
          name,
          message: 'Only the github, repository, and model adapters do I/O.',
        })),
      ],
      'no-restricted-properties': [
        'error',
        ...['getBuiltinModule', 'binding', 'dlopen'].map((property) => ({
          object: 'process',
          property,
          message:
            'Only the github, repository, and model adapters load built-in or native modules.',
        })),
      ],
    },
  },
  // eslint-config-prettier only turns code rules off, so it stays on code
  // files and never reaches Markdown.
  { ...prettier, files: codeFiles },
  // Markdown uses the plugin's recommended rules with the GitHub-Flavored
  // parser, so tables are parsed as tables. Generated agent definitions and
  // skills start with YAML front matter. These rules report problems such as
  // broken links and wrong table column counts; they never reformat text.
  ...markdown.configs.recommended.map((config) => ({
    ...config,
    files: ['**/*.md'],
    language: 'markdown/gfm',
    languageOptions: { frontmatter: 'yaml' },
  })),
];
