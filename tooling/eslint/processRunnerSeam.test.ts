import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint, RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import repositoryConfig from '../../eslint.config.mjs';
import { describe, expect, it, test } from 'vitest';
import processRunner from './processRunnerSeam.ts';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const fixtures = fileURLToPath(
  new URL('fixtures/processRunner/', import.meta.url),
);
const rule = processRunner.rules?.['seam'];
if (rule === undefined || typeof rule === 'function')
  throw new Error('The process-runner plugin has no seam rule');

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const root = '/repo';
const tester = new RuleTester({
  languageOptions: { parser: tseslint.parser },
});

const runner = '../../src/repository/ReadOnlyProcessRunner.ts';
const imports = (names: string) => `import { ${names} } from '${runner}';\n`;

const valid = (code: string, file = 'apps/action/a.ts') => ({
  name: `${file}: ${code}`,
  filename: `${root}/${file}`,
  code,
  options: [{ root }],
});

const invalid = (
  code: string,
  ...errors: Array<{ messageId: string; data?: Record<string, string> }>
) => ({ ...valid(code), errors });

tester.run('process-runner/seam', rule, {
  valid: [
    valid(
      `${imports('ReadOnlyProcessRunner')}new ReadOnlyProcessRunner({ home, redactor });`,
    ),
    valid(
      `${imports('ReadOnlyProcessRunner as Runner')}new Runner({ home: '/h', 'redactor': r });`,
    ),
    // Type positions cannot build a runner.
    valid(
      `${imports('ReadOnlyProcessRunner, type ProcessLimits')}let r: ReadOnlyProcessRunner;\nlet l: ProcessLimits;`,
    ),
    valid(
      `import type { ReadOnlyProcessRunner } from '${runner}';\nlet r: ReadOnlyProcessRunner;`,
    ),
    // The rest of the module is open.
    valid(
      `${imports('normativeGitArguments, gitEnvironment')}export { approvedBinaryPaths } from '${runner}';`,
    ),
    // The same names from another module are not the seam.
    valid(
      "import { nodeProcessSpawner } from './elsewhere.ts';\nimport * as fs from 'node:fs';\nexport * from './other.ts';\nawait import('./other.ts');\nawait import(name);\nrequire('./other.ts');\nload('../../src/repository/ReadOnlyProcessRunner.ts');",
    ),
    // The runner module itself defines the seam.
    valid(
      'export const nodeProcessSpawner = () => undefined;\nconst runner = new ReadOnlyProcessRunner({ home, redactor, spawner: nodeProcessSpawner });',
      'src/repository/ReadOnlyProcessRunner.ts',
    ),
  ],
  invalid: [
    invalid(imports('nodeProcessSpawner'), {
      messageId: 'seam',
      data: { name: 'nodeProcessSpawner' },
    }),
    invalid(
      `import { type ProcessSpawner, type SpawnRequest, type SpawnOutcome } from '../../src/repository/ReadOnlyProcessRunner.js';`,
      { messageId: 'seam', data: { name: 'ProcessSpawner' } },
      { messageId: 'seam', data: { name: 'SpawnRequest' } },
      { messageId: 'seam', data: { name: 'SpawnOutcome' } },
    ),
    invalid(
      `import { nodeProcessSpawner } from '/repo/src/repository/ReadOnlyProcessRunner.ts';`,
      { messageId: 'seam' },
    ),
    invalid(
      `export { nodeProcessSpawner as spawn, ReadOnlyProcessRunner } from '${runner}';`,
      { messageId: 'seam', data: { name: 'nodeProcessSpawner' } },
      { messageId: 'reexportRunner' },
    ),
    invalid(`import * as runner from '${runner}';`, {
      messageId: 'wholeModule',
    }),
    invalid(`export * from '${runner}';`, { messageId: 'wholeModule' }),
    invalid(`const runner = await import(\`${runner}\`);`, {
      messageId: 'wholeModule',
    }),
    invalid(`const runner = require('${runner}');`, {
      messageId: 'wholeModule',
    }),
    // A spawner, or anything that could hold one, never reaches the runner.
    invalid(
      `${imports('ReadOnlyProcessRunner')}new ReadOnlyProcessRunner({ home, redactor, spawner });`,
      { messageId: 'runnerUse' },
    ),
    invalid(
      `${imports('ReadOnlyProcessRunner')}new ReadOnlyProcessRunner({ home, redactor, ['spawn' + 'er']: s });`,
      { messageId: 'runnerUse' },
    ),
    invalid(
      `${imports('ReadOnlyProcessRunner')}new ReadOnlyProcessRunner({ home, ...rest });`,
      { messageId: 'runnerUse' },
    ),
    invalid(
      `${imports('ReadOnlyProcessRunner')}new ReadOnlyProcessRunner(dependencies);`,
      { messageId: 'runnerUse' },
    ),
    invalid(
      `${imports('ReadOnlyProcessRunner')}new ReadOnlyProcessRunner({ home, redactor }, extra);`,
      { messageId: 'runnerUse' },
    ),
    // Aliasing, subclassing, or passing the class around escapes the check.
    invalid(
      `${imports('ReadOnlyProcessRunner')}const Runner = ReadOnlyProcessRunner;\nclass Mine extends ReadOnlyProcessRunner {}\nReflect.construct(ReadOnlyProcessRunner, [d]);\nexport { ReadOnlyProcessRunner };`,
      { messageId: 'runnerUse' },
      { messageId: 'runnerUse' },
      { messageId: 'runnerUse' },
      { messageId: 'runnerUse' },
    ),
    // Without a root option, ESLint's working directory is the root.
    {
      name: 'default root',
      filename: path.join(process.cwd(), 'apps/action/a.ts'),
      code: imports('nodeProcessSpawner'),
      errors: [{ messageId: 'seam' }],
    },
  ],
});

describe('the repository lint configuration', () => {
  // The repository configuration, imported here rather than loaded by ESLint
  // so the rule runs as the same module instance that coverage measures.
  const eslint = new ESLint({
    cwd: repositoryRoot,
    overrideConfigFile: true,
    overrideConfig: repositoryConfig,
  });
  const lintFixture = async (relative: string) => {
    const text = readFileSync(path.join(fixtures, relative), 'utf8');
    const [result] = await eslint.lintText(text, { filePath: relative });
    return (result?.messages ?? []).map(({ ruleId, severity, message }) => ({
      ruleId,
      severity,
      message,
    }));
  };

  test('fails a fixture that builds a runner with a file-transport spawner', async () => {
    expect(await lintFixture('apps/action/addsFileTransport.ts')).toEqual([
      {
        ruleId: 'process-runner/seam',
        severity: 2,
        message:
          'Production code may not import or re-export `nodeProcessSpawner`: the process spawner is the test harness seam.',
      },
      {
        ruleId: 'process-runner/seam',
        severity: 2,
        message:
          'Production code may use ReadOnlyProcessRunner only as `new ReadOnlyProcessRunner({ home, redactor })`, so it never passes a spawner.',
      },
    ]);
  });

  test('passes a fixture that builds a runner from its home and redactor', async () => {
    expect(await lintFixture('apps/action/buildsRunner.ts')).toEqual([]);
  });

  test('leaves tests beside the source and the harness to use the seam', async () => {
    const code = `${imports('nodeProcessSpawner, ReadOnlyProcessRunner')}export const r = new ReadOnlyProcessRunner({ home: '/h', redactor: r, spawner: nodeProcessSpawner });\n`;
    for (const filePath of ['apps/action/a.test.ts', 'tests/support/a.ts']) {
      const [result] = await eslint.lintText(code, { filePath });
      expect(
        result?.messages.filter(
          ({ ruleId }) => ruleId === 'process-runner/seam',
        ),
        filePath,
      ).toEqual([]);
    }
  });

  test('ignores the fixtures when linting the repository', async () => {
    expect(
      await eslint.isPathIgnored(
        'tooling/eslint/fixtures/processRunner/apps/action/addsFileTransport.ts',
      ),
    ).toBe(true);
  });
});
