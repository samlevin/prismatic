import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint, RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import repositoryConfig from '../../eslint.config.mjs';
import { describe, expect, it, test } from 'vitest';
import boundaries, {
  locate,
  packageName,
  sourceModules,
  type BoundaryOptions,
} from './importBoundaries.ts';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const fixtures = fileURLToPath(
  new URL('fixtures/boundaries/', import.meta.url),
);
const rule = boundaries.rules?.['imports'];
if (rule === undefined || typeof rule === 'function')
  throw new Error('The boundaries plugin has no imports rule');

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const root = '/repo';
const tester = new RuleTester({
  languageOptions: { parser: tseslint.parser },
});

type Case = {
  readonly file: string;
  readonly code: string;
  readonly options?: BoundaryOptions;
};

const valid = ({ file, code, options = {} }: Case) => ({
  name: `${file}: ${code}`,
  filename: `${root}/${file}`,
  code,
  options: [{ root, ...options }],
});

const invalid = (
  { file, code, options = {} }: Case,
  ...errors: Array<{ messageId: string; data?: Record<string, string> }>
) => ({ ...valid({ file, code, options }), errors });

tester.run('boundaries/imports', rule, {
  valid: [
    // Every module may import from itself.
    valid({ file: 'src/shared/a.ts', code: "import { x } from './b.ts';" }),
    valid({
      file: 'src/github/GitHubReviewPublisher.ts',
      code: "import { GitHubGateway } from './GitHubGateway.ts';",
    }),
    valid({
      file: 'src/pipeline/steps/infer.ts',
      code: "import { state } from '../PipelineState.ts';",
    }),
    // Imports that flow inward.
    valid({
      file: 'src/core/a.ts',
      code: "import { x } from '../shared/x.ts';",
    }),
    valid({
      file: 'src/findings/a.ts',
      code: "import { ports } from '../core/ports.ts';\nimport { codec } from '../state/StateCodec.ts';",
    }),
    valid({
      file: 'src/github/a.ts',
      code: "import { render } from '../presentation/x.ts';\nimport type { Port } from '../core/ports.ts';",
    }),
    valid({
      file: 'src/pipeline/steps/a.ts',
      code: "import { x } from '../../evidence/x.ts';\nimport { y } from '../../core/ports.ts';",
    }),
    valid({
      file: 'apps/action/ActionBootstrap.ts',
      code: "import { GitHubGateway } from '../../src/github/GitHubGateway.ts';\nimport type { Port } from '../../src/core/ports.ts';\nimport { ReviewPipeline } from '../../src/pipeline/ReviewPipeline.ts';\nimport { cli } from '../cli/CliBootstrap.ts';",
    }),
    // Re-exports and dynamic imports follow the same rules.
    valid({ file: 'src/core/a.ts', code: "export * from '../shared/x.ts';" }),
    valid({
      file: 'src/core/a.ts',
      code: "export { x } from '../shared/x.ts';\nexport const y = 1;",
    }),
    valid({
      file: 'src/core/a.ts',
      code: 'const x = await import(`../shared/x.ts`);',
    }),
    // Adapters may import SDKs and I/O built-ins.
    valid({
      file: 'src/repository/a.ts',
      code: "import { spawn } from 'node:child_process';\nimport { readFile } from 'fs/promises';\nimport OpenAI from 'openai';",
    }),
    valid({ file: 'src/model/a.ts', code: "import OpenAI from 'openai';" }),
    // Built-ins without I/O are open to every module.
    valid({
      file: 'src/shared/digest.ts',
      code: "import { createHash } from 'node:crypto';\nimport path from 'path';\nimport { posix } from 'node:path/posix';\nimport { setTimeout } from 'node:timers/promises';\nimport { types } from 'util/types';",
    }),
    // Inline type imports follow the same rules.
    valid({
      file: 'src/pipeline/a.ts',
      code: "type Port = import('../core/ports.ts').Port;",
    }),
    valid({
      file: 'src/model/a.ts',
      code: "type Client = typeof import('openai');",
    }),
    // Listed pure packages are open to every module.
    valid({
      file: 'src/shared/schemas.ts',
      code: "import { z } from 'zod';\nimport { a } from '@scope/pure/sub';",
      options: { packages: ['zod', '@scope/pure'] },
    }),
    // A narrow exception for one file and one specifier.
    valid({
      file: 'apps/action/main.ts',
      code: "import { openSync } from 'node:fs';",
      options: {
        exceptions: [{ file: 'apps/action/main.ts', imports: ['node:fs'] }],
      },
    }),
    // Calls that are not require() are not imports.
    valid({ file: 'src/shared/a.ts', code: "load('fs');\nrequire();" }),
    // Files outside src/ and apps/, or outside the root, are not checked.
    valid({
      file: 'tooling/a.ts',
      code: "import { readFileSync } from 'node:fs';",
    }),
    {
      filename: '/elsewhere/src/shared/a.ts',
      code: "import { x } from '../core/x.ts';",
      options: [{ root }],
    },
  ],
  invalid: [
    invalid(
      { file: 'src/shared/a.ts', code: "import { x } from '../core/x.ts';" },
      {
        messageId: 'forbiddenModule',
        data: {
          fromKind: 'shared',
          from: 'shared',
          toKind: 'core',
          to: 'core',
        },
      },
    ),
    invalid(
      { file: 'src/core/a.ts', code: "import { x } from '../state/x.ts';" },
      { messageId: 'forbiddenModule' },
    ),
    invalid(
      {
        file: 'src/findings/a.ts',
        code: "import { x } from '../github/x.ts';",
      },
      {
        messageId: 'forbiddenModule',
        data: {
          fromKind: 'domain',
          from: 'findings',
          toKind: 'adapter',
          to: 'github',
        },
      },
    ),
    invalid(
      {
        file: 'src/pipeline/steps/a.ts',
        code: "import { ModelGateway } from '../../model/ModelGateway.ts';",
      },
      { messageId: 'forbiddenModule' },
    ),
    invalid(
      {
        file: 'src/github/a.ts',
        code: "import { x } from '../repository/x.ts';",
      },
      { messageId: 'forbiddenModule' },
    ),
    invalid(
      { file: 'src/model/a.ts', code: "import { x } from '../pipeline/x.ts';" },
      { messageId: 'forbiddenModule' },
    ),
    invalid(
      {
        file: 'src/presentation/a.ts',
        code: "import { x } from '../../apps/action/x.ts';",
      },
      {
        messageId: 'forbiddenModule',
        data: {
          fromKind: 'domain',
          from: 'presentation',
          toKind: 'apps',
          to: 'apps/action',
        },
      },
    ),
    invalid(
      { file: 'src/pipeline/a.ts', code: "export * from '../github/x.ts';" },
      { messageId: 'forbiddenModule' },
    ),
    invalid(
      { file: 'src/shared/a.ts', code: "export { x } from '../core/x.ts';" },
      { messageId: 'forbiddenModule' },
    ),
    invalid(
      {
        file: 'src/state/a.ts',
        code: "const x = await import('../model/x.ts');",
      },
      { messageId: 'forbiddenModule' },
    ),
    // Production code never imports development-only or outside code.
    invalid(
      {
        file: 'src/context/a.ts',
        code: "import { x } from '../../experiments/x.ts';",
      },
      {
        messageId: 'outsideProduction',
        data: { specifier: '../../experiments/x.ts' },
      },
    ),
    invalid(
      {
        file: 'apps/cli/a.ts',
        code: "import { x } from '../../evals/variants/x.ts';",
      },
      { messageId: 'outsideProduction' },
    ),
    invalid(
      {
        file: 'src/core/a.ts',
        code: "import { x } from '../../../outside.ts';",
      },
      { messageId: 'outsideProduction' },
    ),
    invalid(
      { file: 'src/core/a.ts', code: "import x from '/etc/x.ts';" },
      { messageId: 'outsideProduction' },
    ),
    // Unknown modules fail until the rule classifies them.
    invalid(
      { file: 'src/core/a.ts', code: "import { x } from '../unknown/x.ts';" },
      {
        messageId: 'unclassifiedTarget',
        data: { specifier: '../unknown/x.ts', target: 'src/unknown/x.ts' },
      },
    ),
    invalid(
      { file: 'src/core/a.ts', code: "import { x } from '../index.ts';" },
      { messageId: 'unclassifiedTarget' },
    ),
    invalid(
      { file: 'src/unknown/a.ts', code: 'export const x = 1;' },
      { messageId: 'unclassifiedFile', data: { file: 'src/unknown/a.ts' } },
    ),
    invalid(
      { file: 'src/index.ts', code: 'export {};' },
      { messageId: 'unclassifiedFile' },
    ),
    invalid(
      { file: 'apps/main.ts', code: "import fs from 'node:fs';" },
      { messageId: 'unclassifiedFile', data: { file: 'apps/main.ts' } },
    ),
    invalid(
      {
        file: 'src/core/a.ts',
        code: "import { x } from '../../apps/main.ts';",
      },
      { messageId: 'unclassifiedTarget' },
    ),
    // Inline type imports cannot reach past the rules either.
    invalid(
      {
        file: 'src/pipeline/a.ts',
        code: "type G = import('../github/GitHubGateway.ts').GitHubGateway;",
      },
      { messageId: 'forbiddenModule' },
    ),
    invalid(
      {
        file: 'src/findings/a.ts',
        code: "type Client = typeof import('openai');",
      },
      { messageId: 'adapterOnly', data: { specifier: 'openai' } },
    ),
    // Every built-in outside the pure list is adapter-only, including ones
    // the list has never heard of.
    invalid(
      {
        file: 'src/state/a.ts',
        code: "import { DatabaseSync } from 'node:sqlite';\nimport { WASI } from 'wasi';\nimport v8 from 'node:v8';\nimport readline from 'node:readline';",
      },
      { messageId: 'adapterOnly', data: { specifier: 'node:sqlite' } },
      { messageId: 'adapterOnly', data: { specifier: 'wasi' } },
      { messageId: 'adapterOnly', data: { specifier: 'node:v8' } },
      { messageId: 'adapterOnly', data: { specifier: 'node:readline' } },
    ),
    // SDKs and I/O built-ins belong to adapters.
    invalid(
      { file: 'src/evidence/a.ts', code: "import { readFileSync } from 'fs';" },
      { messageId: 'adapterOnly', data: { specifier: 'fs' } },
    ),
    invalid(
      {
        file: 'src/evidence/a.ts',
        code: "import { readFile } from 'node:fs/promises';\nimport { spawn } from 'node:child_process';\nimport { createRequire } from 'node:module';",
      },
      { messageId: 'adapterOnly' },
      { messageId: 'adapterOnly' },
      { messageId: 'adapterOnly' },
    ),
    invalid(
      { file: 'src/pipeline/a.ts', code: "import OpenAI from 'openai';" },
      { messageId: 'adapterOnly' },
    ),
    invalid(
      {
        file: 'src/core/a.ts',
        code: "import type { Octokit } from '@octokit/rest';",
      },
      { messageId: 'adapterOnly', data: { specifier: '@octokit/rest' } },
    ),
    invalid(
      { file: 'src/rules/a.ts', code: "const fs = require('fs');" },
      { messageId: 'adapterOnly' },
    ),
    invalid(
      { file: 'apps/action/main.ts', code: "import fs from 'node:fs';" },
      { messageId: 'adapterOnly' },
    ),
    invalid(
      {
        file: 'apps/cli/main.ts',
        code: "import fs from 'node:fs';",
        options: {
          exceptions: [{ file: 'apps/action/main.ts', imports: ['node:fs'] }],
        },
      },
      { messageId: 'adapterOnly' },
    ),
    // A computed specifier cannot be checked, so it fails.
    invalid(
      { file: 'src/core/a.ts', code: 'const x = await import(name);' },
      { messageId: 'computedImport' },
    ),
    invalid(
      {
        file: 'src/core/a.ts',
        code: 'const x = await import(`../${name}.ts`);',
      },
      { messageId: 'computedImport' },
    ),
    invalid(
      { file: 'src/core/a.ts', code: 'const x = require(name);' },
      { messageId: 'computedImport' },
    ),
    // Without a root option, ESLint's working directory is the root.
    {
      name: 'default root',
      filename: path.join(process.cwd(), 'src/shared/a.ts'),
      code: "import { x } from '../core/x.ts';",
      errors: [{ messageId: 'forbiddenModule' }],
    },
  ],
});

test('locate classifies src modules, apps, and everything else', () => {
  expect(locate('src/core/ports.ts')).toEqual({ module: 'core', kind: 'core' });
  expect(locate('src/pipeline/steps/a.ts')).toEqual({
    module: 'pipeline',
    kind: 'pipeline',
  });
  expect(locate('apps/action/main.ts')).toEqual({
    module: 'apps/action',
    kind: 'apps',
  });
  expect(locate('src/index.ts')).toEqual({ module: '', kind: undefined });
  expect(locate('src')).toEqual({ module: '', kind: undefined });
  expect(locate('src/toString/a.ts')).toEqual({
    module: 'toString',
    kind: undefined,
  });
  expect(locate('apps/main.ts')).toEqual({ module: '', kind: undefined });
  expect(locate('apps')).toEqual({ module: '', kind: undefined });
  expect(locate('tooling/CoverageGate.ts')).toBeUndefined();
});

test('packageName keeps the scope of a scoped package', () => {
  expect(packageName('openai/resources')).toBe('openai');
  expect(packageName('@octokit/rest/dist')).toBe('@octokit/rest');
  expect(packageName('zod')).toBe('zod');
});

test('every directory under src/ is a classified module, with a file that compiles', () => {
  const directories = readdirSync(path.join(repositoryRoot, 'src'), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  expect(directories).toEqual(Object.keys(sourceModules).sort());
  for (const directory of directories)
    expect(
      readdirSync(path.join(repositoryRoot, 'src', directory)).some((name) =>
        name.endsWith('.ts'),
      ),
      directory,
    ).toBe(true);
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

  test('fails a fixture where shared imports core', async () => {
    expect(await lintFixture('src/shared/importsCore.ts')).toEqual([
      {
        ruleId: 'boundaries/imports',
        severity: 2,
        message:
          'The shared module `shared` may not import the core module `core`.',
      },
    ]);
  });

  test('fails a fixture where the pipeline imports an adapter', async () => {
    expect(await lintFixture('src/pipeline/importsAdapter.ts')).toEqual([
      {
        ruleId: 'boundaries/imports',
        severity: 2,
        message:
          'The pipeline module `pipeline` may not import the adapter module `github`.',
      },
    ]);
  });

  test('fails a fixture where a domain module imports fs', async () => {
    expect(await lintFixture('src/findings/importsFs.ts')).toEqual([
      {
        ruleId: 'boundaries/imports',
        severity: 2,
        message:
          'Only the github, repository, and model adapters may import `node:fs`.',
      },
    ]);
  });

  test('passes a fixture where core imports shared', async () => {
    expect(await lintFixture('src/core/importsShared.ts')).toEqual([]);
  });

  test('leaves tests beside the source to import test tooling', async () => {
    const [result] = await eslint.lintText(
      "import { readFileSync } from 'node:fs';\nimport { test } from 'vitest';\n\ntest('reads', () => readFileSync);\n",
      { filePath: 'src/shared/a.test.ts' },
    );
    expect(result?.messages).toEqual([]);
  });

  test('fails I/O through globals outside the adapters', async () => {
    const code =
      "await fetch('https://example.invalid');\nprocess.getBuiltinModule('node:fs');\n";
    const lint = async (filePath: string) => {
      const [result] = await eslint.lintText(code, { filePath });
      return (result?.messages ?? []).map(({ ruleId }) => ruleId);
    };
    expect(await lint('src/context/a.ts')).toEqual([
      'no-restricted-globals',
      'no-restricted-properties',
    ]);
    expect(await lint('apps/cli/main.ts')).toHaveLength(2);
    expect(await lint('src/github/a.ts')).toEqual([]);
    expect(await lint('src/context/a.test.ts')).toEqual([]);
  });

  test('ignores only the boundary fixtures, not fixtures elsewhere', async () => {
    expect(await eslint.isPathIgnored('src/evidence/fixtures/a.ts')).toBe(
      false,
    );
  });

  test('ignores the fixtures when linting the repository', async () => {
    expect(
      await eslint.isPathIgnored(
        'tooling/eslint/fixtures/boundaries/src/shared/importsCore.ts',
      ),
    ).toBe(true);
  });
});
