// Adversarial inputs for ReadOnlyProcessRunner (#148), run against a real
// git through the test harness. The shell-metacharacter names are the
// `shell-metacharacters` scenario of the fixture corpus in #139; until that
// corpus lands they are listed here.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ESLint, type Linter } from 'eslint';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import repositoryConfig from '../../eslint.config.mjs';
import {
  normativeGitArguments,
  type ProcessLimits,
  ReadOnlyProcessRunner,
} from '../../src/repository/ReadOnlyProcessRunner.ts';
import { createSecretRedactor } from '../../src/shared/redaction.ts';
import { credentialExamples } from '../support/credentials.ts';
import {
  fileProtocolConfig,
  findOnPath,
  harnessProcessRunner,
  harnessSpawner,
} from '../support/processHarness.ts';

// File names built to run a command through a shell, expand as a glob, or be
// parsed as a Git option.
const shellMetacharacterNames = [
  'src/$(touch prism-canary-subshell).ts',
  'src/`touch prism-canary-backtick`.ts',
  'src/a; touch prism-canary-semicolon.ts',
  'src/a | tee prism-canary-pipe > out & echo.ts',
  'src/it\'s "quoted".ts',
  'src/*.ts',
  'src/[a-z].ts',
  '--upload-pack=touch prism-canary-option.ts',
  '--output=prism-canary-output.ts',
] as const;

const executionCanaries = [
  'prism-canary-subshell',
  'prism-canary-backtick',
  'prism-canary-semicolon',
  'prism-canary-pipe',
  'prism-canary-option',
  'prism-canary-output',
  'out',
];

const repositoryRoot = path.resolve(import.meta.dirname, '../..');

let directory: string;
let home: string;
let limits: ProcessLimits;

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'prismatic-runner-'));
  home = path.join(directory, 'home');
  mkdirSync(home);
  mkdirSync(path.join(directory, 'work'));
  limits = {
    cwd: path.join(directory, 'work'),
    timeoutMs: 30_000,
    maxStdoutBytes: 1024 * 1024,
    maxStderrBytes: 64 * 1024,
  };
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

// Every file and directory name under `root`, at any depth.
function names(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: 'utf8' }).map((entry) =>
    path.basename(entry),
  );
}

describe('ReadOnlyProcessRunner against a real git', () => {
  it('has a local git to test with', () => {
    expect(findOnPath('git')).toBeDefined();
  });

  it.each(shellMetacharacterNames)(
    'passes %j to git literally and runs nothing it names',
    async (name) => {
      const runner = harnessProcessRunner({ home });
      const result = await runner.runBinary(
        'git',
        ['init', '--quiet', '--bare', '--template=', '--', name],
        limits,
      );
      expect(result.stderr).toBe('');
      expect(result).toMatchObject({ exitCode: 0, termination: 'exited' });
      // git created a repository at exactly the literal path.
      expect(statSync(path.join(limits.cwd, name, 'HEAD')).isFile()).toBe(true);
      const created = names(directory);
      for (const canary of executionCanaries)
        expect(created).not.toContain(canary);
    },
  );

  it('applies the normative configuration and no system or global file', async () => {
    const runner = harnessProcessRunner({ home });
    const result = await runner.runBinary(
      'git',
      ['config', '--list', '--show-scope'],
      limits,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString('utf8').trim().split('\n')).toEqual([
      'command\tcore.hookspath=/dev/null',
      'command\tcore.fsmonitor=false',
      'command\tdiff.external=',
      'command\tprotocol.allow=never',
      'command\tprotocol.https.allow=always',
      'command\tsubmodule.recurse=false',
      'command\tcredential.helper=',
    ]);
  });

  it('refuses a file:// remote unless the harness hook allows it', async () => {
    const remote = path.join(directory, 'remote.git');
    const setup = harnessProcessRunner({ home });
    await setup.runBinary(
      'git',
      ['init', '--quiet', '--bare', '--template=', '--', remote],
      limits,
    );
    const url = `file://${remote}`;

    const production = harnessProcessRunner({ home });
    const refused = await production.runBinary(
      'git',
      ['ls-remote', '--', url],
      limits,
    );
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("transport 'file' not allowed");

    const harness = harnessProcessRunner({ home, allowFileProtocol: true });
    const allowed = await harness.runBinary(
      'git',
      ['ls-remote', '--', url],
      limits,
    );
    expect(allowed).toMatchObject({ exitCode: 0, stderr: '' });
  });

  it('adds the hook after the normative options and only to git', async () => {
    const seen: (readonly string[])[] = [];
    const runner = new ReadOnlyProcessRunner({
      home,
      redactor: createSecretRedactor(),
      spawner: harnessSpawner({
        allowFileProtocol: true,
        binaries: { 'ast-grep': '/opt/ast-grep' },
        spawner: (request) => {
          seen.push(request.args);
          return Promise.resolve({
            exitCode: 0,
            signal: null,
            termination: 'exited',
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
          });
        },
      }),
    });
    await runner.runBinary('git', ['fetch'], limits);
    await runner.runBinary('ast-grep', ['scan'], limits);
    expect(seen[0]).toEqual([
      ...normativeGitArguments,
      '-c',
      fileProtocolConfig,
      'fetch',
    ]);
    expect(seen[1]).toEqual(['scan']);
  });

  it('kills git when its output passes the cap', async () => {
    const runner = harnessProcessRunner({ home });
    const capped = await runner.runBinary(
      'git',
      ['config', '--list', '--show-scope'],
      { ...limits, maxStdoutBytes: 16 },
    );
    expect(capped.termination).toBe('stdout-limit');
    expect(capped.stdout).toHaveLength(16);
  });

  it('redacts a credential that git echoes on stderr', async () => {
    const token = credentialExamples['github-token'] as string;
    const runner = harnessProcessRunner({ home });
    await runner.runBinary(
      'git',
      ['init', '--quiet', '--bare', '--template=', '--', 'objects.git'],
      limits,
    );
    const result = await runner.runBinary('git', ['rev-parse', token], {
      ...limits,
      cwd: path.join(limits.cwd, 'objects.git'),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('[REDACTED:github-token]');
    expect(result.stderr).not.toContain(token);
  });
});

describe('the file-protocol hook', () => {
  // Production files under src/ and apps/, without their tests.
  function productionFiles(): string[] {
    return ['src', 'apps'].flatMap((top) =>
      readdirSync(path.join(repositoryRoot, top), {
        recursive: true,
        encoding: 'utf8',
      })
        .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.test.ts'))
        .map((entry) => path.join(repositoryRoot, top, entry)),
    );
  }

  it('is unreachable from production code', async () => {
    const eslint = new ESLint({
      cwd: repositoryRoot,
      overrideConfigFile: true,
      overrideConfig: repositoryConfig,
    });
    const files = productionFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const config = (await eslint.calculateConfigForFile(
        file,
      )) as Linter.Config;
      expect(config.rules?.['process-runner/seam'], file).toEqual([
        2,
        { root: `${repositoryRoot}${path.sep}` },
      ]);
    }
    // Copied into production code, the harness itself fails lint.
    const [result] = await eslint.lintText(
      readFileSync(
        path.join(repositoryRoot, 'tests/support/processHarness.ts'),
        'utf8',
      ),
      { filePath: 'apps/action/processHarness.ts' },
    );
    expect(
      result?.messages
        .filter(({ ruleId }) => ruleId === 'process-runner/seam')
        .map(({ messageId }) => messageId),
    ).toEqual(['seam', 'seam', 'runnerUse']);
  });

  it('lives outside the compiled build', () => {
    const build = JSON.parse(
      readFileSync(path.join(repositoryRoot, 'tsconfig.build.json'), 'utf8'),
    ) as { include: string[] };
    expect(build.include).toEqual(['src/**/*.ts', 'apps/**/*.ts']);
    expect(
      existsSync(path.join(repositoryRoot, 'tests/support/processHarness.ts')),
    ).toBe(true);
  });
});
