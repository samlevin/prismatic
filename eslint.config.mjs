import { fileURLToPath } from 'node:url';
import eslint from '@eslint/js';
import markdown from '@eslint/markdown';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import boundaries, {
  sourceModules,
} from './tooling/eslint/importBoundaries.ts';

const javascriptFiles = ['**/*.{js,mjs,cjs}'];
const typescriptFiles = ['**/*.ts'];
const codeFiles = [...javascriptFiles, ...typescriptFiles];

// The adapters come from the boundary rule's module table, so the two lists
// cannot drift.
const adapters = Object.entries(sourceModules)
  .filter(([, kind]) => kind === 'adapter')
  .map(([name]) => name);
const adapterList = `${adapters.slice(0, -1).join(', ')}, and ${adapters.at(-1)}`;
const ioGlobals = ['fetch', 'WebSocket', 'EventSource'];
const ioMessage = `Only the ${adapterList} adapters do I/O.`;
const nativeMessage = `Only the ${adapterList} adapters load built-in or native modules.`;

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
            // The entrypoint's root-only descriptor work, and the stub's
            // first git process until ActionBootstrap exists.
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
    ignores: ['**/*.test.ts', ...adapters.map((name) => `src/${name}/**`)],
    rules: {
      'no-restricted-globals': [
        'error',
        ...ioGlobals.map((name) => ({ name, message: ioMessage })),
      ],
      'no-restricted-properties': [
        'error',
        ...ioGlobals.map((property) => ({
          object: 'globalThis',
          property,
          message: ioMessage,
        })),
        ...['getBuiltinModule', 'binding', 'dlopen'].map((property) => ({
          object: 'process',
          property,
          message: nativeMessage,
        })),
        { object: 'globalThis', property: 'process', message: nativeMessage },
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
