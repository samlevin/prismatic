import eslint from '@eslint/js';
import markdown from '@eslint/markdown';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

const javascriptFiles = ['**/*.{js,mjs,cjs}'];

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
    files: javascriptFiles,
    languageOptions: {
      globals: globals.node,
    },
  },
  // eslint-config-prettier only turns JavaScript rules off, so it stays on
  // JavaScript files and never reaches Markdown.
  { ...prettier, files: javascriptFiles },
  // Markdown uses the plugin's recommended rules with the GitHub-Flavored
  // parser, so tables are parsed as tables. Generated agent definitions and
  // skills start with YAML front matter. These rules report problems such as
  // broken links and wrong table column counts; they never reformat prose.
  ...markdown.configs.recommended.map((config) => ({
    ...config,
    files: ['**/*.md'],
    language: 'markdown/gfm',
    languageOptions: { frontmatter: 'yaml' },
  })),
];
