import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

// Lints text with the repository's own eslint.config.mjs, as `npm run lint`
// and `npm run lint:md` do. Nothing is written to disk.
const cwd = fileURLToPath(new URL('..', import.meta.url));
const eslint = new ESLint({ cwd });

async function problems(text, filePath = 'docs/fixture.md') {
  const [result] = await eslint.lintText(text, { filePath, warnIgnored: true });
  return result.messages.map(({ ruleId, severity }) => ({ ruleId, severity }));
}

test('a broken link fragment fails Markdown lint', async () => {
  assert.deepEqual(await problems('# Title\n\nSee [the setup](#setup).\n'), [
    { ruleId: 'markdown/no-missing-link-fragments', severity: 2 },
  ]);
  assert.deepEqual(
    await problems('# Title\n\n## Setup\n\nSee [the setup](#setup).\n'),
    [],
  );
});

test('a table row with too many cells fails Markdown lint', async () => {
  assert.deepEqual(
    await problems('# Title\n\n| A | B |\n| --- | --- |\n| 1 | 2 | 3 |\n'),
    [{ ruleId: 'markdown/table-column-count', severity: 2 }],
  );
});

test('Markdown lint accepts compact tables, front matter, and line breaks as written', async () => {
  const text = [
    '---',
    'name: prism-example',
    'description: Example front matter.',
    '---',
    '',
    '# Title',
    '',
    '| Changed | Run |',
    '| --- | --- |',
    '| A row whose first cell is much wider than the header | `npm run lint:md` |',
    '',
    'Return exactly:',
    'VERDICT',
    'Findings',
    '',
  ].join('\n');
  assert.deepEqual(await problems(text), []);
});

test('JavaScript rules never reach Markdown, and still apply to JavaScript', async () => {
  // Neither the JavaScript rules nor eslint-config-prettier's `off` entries
  // may configure Markdown files.
  const { rules } = await eslint.calculateConfigForFile('docs/fixture.md');
  const ruleIds = Object.keys(rules);
  assert.ok(ruleIds.length > 0);
  assert.deepEqual(
    ruleIds.filter((ruleId) => !ruleId.startsWith('markdown/')),
    [],
  );
  assert.deepEqual(await problems('undefinedName;\n', 'scripts/fixture.mjs'), [
    { ruleId: 'no-undef', severity: 2 },
  ]);
});

test('Markdown in agent worktrees is ignored', async () => {
  for (const filePath of [
    '.claude/worktrees/agent/README.md',
    '.codex/worktrees/agent/README.md',
  ])
    assert.equal(
      await eslint.isPathIgnored(filePath),
      true,
      `${filePath} is linted`,
    );
});

test('untracked personal agent files are not linted', async () => {
  for (const filePath of [
    'CLAUDE.local.md',
    'docs/CLAUDE.local.md',
    'AGENTS.override.md',
  ])
    assert.equal(
      await eslint.isPathIgnored(filePath),
      true,
      `${filePath} is linted`,
    );
  assert.equal(await eslint.isPathIgnored('AGENTS.md'), false);
});
