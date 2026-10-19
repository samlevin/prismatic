import { describe, expect, it } from 'vitest';
import { securityScenario } from './fixtures/security/scenarios.ts';
import { InstrumentedProcessRunner } from './InstrumentedProcessRunner.ts';
import {
  SecurityScenarioRunner,
  SecurityScenarioViolation,
  hostFiles,
  repositoryRoot,
  type ScenarioSubject,
} from './SecurityScenarioRunner.ts';

const violations = async (assertion: Promise<void>): Promise<string[]> => {
  try {
    await assertion;
    return [];
  } catch (error) {
    if (error instanceof SecurityScenarioViolation)
      return [...error.violations];
    throw error;
  }
};

const runner = (id: string, subject: ScenarioSubject, revision?: string) =>
  new SecurityScenarioRunner(
    securityScenario(id),
    subject,
    revision === undefined ? {} : { revision },
  );

describe('InstrumentedProcessRunner', () => {
  it('records requests without running anything and answers from the responder', async () => {
    const processes = new InstrumentedProcessRunner(({ args }) => ({
      exitCode: 3,
      stdout: args.join(','),
      stderr: '',
    }));
    const args = ['a', 'b'];
    const env = { X: '1' };
    expect(
      await processes.run('git', args, { env, input: 'HEAD:a.ts\n' }),
    ).toEqual({
      exitCode: 3,
      stdout: 'a,b',
      stderr: '',
    });
    args.push('c');
    env.X = '2';
    expect(processes.requests).toEqual([
      {
        command: 'git',
        args: ['a', 'b'],
        options: { env: { X: '1' }, input: 'HEAD:a.ts\n' },
      },
    ]);
    expect(await new InstrumentedProcessRunner().run('git')).toEqual({
      exitCode: 0,
      stdout: '',
      stderr: '',
    });
  });
});

describe('assertNeverReads', () => {
  it('catches a read that reaches a forbidden file through a symlink chain', async () => {
    const scenario = runner('symlink-chains', async ({ fileSystem }) => {
      await fileSystem.readFile('src/chain-1.ts');
      await fileSystem.readFile('src/escape.ts');
    });
    expect(await violations(scenario.assertNeverReads(['.env']))).toEqual([
      'readFile "src/chain-1.ts" (resolved to "/repo/.env") reads forbidden "/repo/.env"',
    ]);
    expect(
      await violations(scenario.assertNeverReads(['/etc/passwd'])),
    ).toHaveLength(1);
  });

  it('passes a reader that checks with lstat and opens without following', async () => {
    const scenario = securityScenario('symlink-chains');
    const careful = new SecurityScenarioRunner(
      scenario,
      async ({ fileSystem }) => {
        for (const path of [
          'src/index.ts',
          'src/chain-1.ts',
          'src/escape.ts',
        ]) {
          const stats = await fileSystem.lstat(path);
          if (stats.type !== 'file') continue;
          await fileSystem.readFile(path, { noFollow: true });
        }
      },
    );
    await expect(
      careful.assertNeverReads([...scenario.expectations.neverRead]),
    ).resolves.toBeUndefined();
  });

  it('counts an attempted read of a forbidden path even when it fails', async () => {
    const scenario = runner('symlink-chains', async ({ fileSystem }) => {
      await fileSystem.readFile('lib/../.env/x');
    });
    const { accesses } = await scenario.run();
    expect(accesses[0]?.resolved).toBeNull();
    expect(await violations(scenario.assertNeverReads(['.env']))).toEqual([
      'readFile "lib/../.env/x" reads forbidden "/repo/.env"',
    ]);
  });

  it('treats a directory as covering everything below it', async () => {
    const scenario = runner('tracked-ignored-files', async ({ fileSystem }) => {
      await fileSystem.readFile(`${repositoryRoot}/secrets/prod.ts`);
      await fileSystem.readFile('src/app.ts');
      await fileSystem.readdir('secrets');
    });
    expect(await violations(scenario.assertNeverReads(['secrets']))).toEqual([
      'readFile "/repo/secrets/prod.ts" reads forbidden "/repo/secrets"',
    ]);
    expect(await violations(scenario.assertNeverReads(['/']))).toHaveLength(2);
  });

  it('mounts the revision it is asked for', async () => {
    const scenario = runner(
      'non-default-base',
      async ({ fileSystem }) => {
        await fileSystem.readFile('AGENTS.md');
      },
      'release',
    );
    const run = await scenario.run();
    expect(run.error).toBeUndefined();
    expect(() => runner('lfs-pointer', () => undefined, 'ghost')).toThrow(
      /no commit labeled ghost/,
    );
  });

  it('judges what a subject did before it threw, and runs it once', async () => {
    let calls = 0;
    const scenario = runner(
      'gitignore-hides-change',
      async ({ fileSystem }) => {
        calls += 1;
        await fileSystem.readFile('src/auth.ts');
        throw new Error('rejected');
      },
    );
    expect(
      await violations(scenario.assertNeverReads(['src/auth.ts'])),
    ).toHaveLength(1);
    await scenario.assertNeverExecutes();
    expect((await scenario.run()).error).toEqual(new Error('rejected'));
    expect(calls).toBe(1);
  });

  it('refuses an empty forbidden path', async () => {
    const scenario = runner('lfs-pointer', () => undefined);
    await expect(scenario.assertNeverReads([''])).rejects.toThrow(/empty/);
  });

  it('exposes host files a symlink can reach', async () => {
    const scenario = runner('symlink-chains', async ({ fileSystem }) => {
      await fileSystem.readFile('src/absolute.ts');
    });
    const { accesses } = await scenario.run();
    expect(accesses[0]?.resolved).toBe('/home/runner/.ssh/id_ed25519');
    expect(Object.keys(hostFiles)).toContain('/proc/self/environ');
  });
});

describe('assertNeverExecutes', () => {
  // The normative Git invocation from §5.3, with the token header passed
  // through the environment and the object store outside the repository.
  const normativeGit = (args: readonly string[], input?: string) =>
    [
      'git',
      [
        '--git-dir',
        '/tmp/prism-store',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'diff.external=',
        '-c',
        'protocol.allow=never',
        '-c',
        'protocol.https.allow=always',
        '-c',
        'submodule.recurse=false',
        '-c',
        'credential.helper=',
        ...args,
      ],
      {
        shell: false,
        cwd: '/tmp',
        ...(input === undefined ? {} : { input }),
        env: {
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          HOME: '/tmp/prism-empty-home',
          GIT_TERMINAL_PROMPT: '0',
          GIT_NO_LAZY_FETCH: '1',
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader',
          GIT_CONFIG_VALUE_0: 'Authorization: Basic abc',
        },
      },
    ] as const;

  it('passes the normative Git invocation with hostile names as data', async () => {
    const scenario = runner(
      'shell-metacharacters',
      async ({ processRunner, revision }) => {
        await processRunner.run(
          ...normativeGit([
            'diff',
            '--no-ext-diff',
            '--no-textconv',
            '-z',
            'main',
            revision,
            '--',
            '--upload-pack=touch prism-canary-option.ts',
            'src/$(touch prism-canary-subshell).ts',
          ]),
        );
        await processRunner.run(
          ...normativeGit(
            [
              'cat-file',
              '-p',
              `${revision}:src/a; touch prism-canary-semicolon.ts`,
            ],
            `${revision}:src/\`touch prism-canary-backtick\`.ts\n`,
          ),
        );
      },
    );
    await expect(scenario.assertNeverExecutes()).resolves.toBeUndefined();
  });

  it('catches configuration and repositories loaded from the repository tree', async () => {
    const scenario = runner(
      'git-config-and-filters',
      async ({ processRunner }) => {
        await processRunner.run('git', ['status'], {
          cwd: '/repo/nested',
          env: { HOME: '/repo', GIT_CONFIG_GLOBAL: '.gitconfig' },
        });
        await processRunner.run('git', [
          '--git-dir=/repo/nested',
          '-C',
          '/repo',
          '-c',
          'include.path=/repo/.gitconfig',
          '--config-env=core.fsmonitor=EVIL',
          'status',
        ]);
      },
    );
    expect(await violations(scenario.assertNeverExecutes())).toEqual([
      '"git" "status": runs inside the repository tree, where Git would find its configuration',
      '"git" "status": points HOME into the repository tree',
      '"git" "status": points GIT_CONFIG_GLOBAL into the repository tree',
      '"git" "--git-dir=/repo/nested -C /repo -c include.path=/repo/.gitconfig --config-env=core.fsmonitor=EVIL status": points --git-dir into the repository tree',
      '"git" "--git-dir=/repo/nested -C /repo -c include.path=/repo/.gitconfig --config-env=core.fsmonitor=EVIL status": points -C into the repository tree',
      '"git" "--git-dir=/repo/nested -C /repo -c include.path=/repo/.gitconfig --config-env=core.fsmonitor=EVIL status": sets "include.path", which loads configuration from a file',
    ]);
  });

  it('catches settings that run a program, and canaries outside path arguments', async () => {
    const scenario = runner(
      'git-config-and-filters',
      async ({ processRunner }) => {
        await processRunner.run(
          'git',
          [
            '--config-env=core.fsmonitor=EVIL',
            '-c',
            'alias.x=!touch /tmp/prism-canary-hook',
            '-c',
            'remote.origin.uploadpack=x',
            '-c',
            'submodule.lib.update=!x',
            '-c',
            'credential.https://example.invalid.helper=x',
            '-c',
            'protocol.allow=always',
            '-c',
            'protocol.ext.allow=user',
            'x',
          ],
          { env: { EVIL: 'x' }, input: 'prism-canary-clean' },
        );
      },
    );
    const where =
      '"git" "--config-env=core.fsmonitor=EVIL -c alias.x=!touch /tmp/prism-canary-hook -c remote.origin.uploadpack=x -c submodule.lib.update=!x -c credential.https://example.invalid.helper=x -c protocol.allow=always -c protocol.ext.allow=user x"';
    expect(await violations(scenario.assertNeverExecutes())).toEqual(
      [
        'sets "core.fsmonitor", which runs a program',
        'sets "alias.x", which runs a program',
        'sets "remote.origin.uploadpack", which runs a program',
        'sets "submodule.lib.update", which runs a program',
        'sets "credential.https://example.invalid.helper", which runs a program',
        'sets "protocol.allow", which allows a transport that runs a program',
        'sets "protocol.ext.allow", which allows a transport that runs a program',
        'carries the planted command "prism-canary-clean"',
        'carries the planted command "prism-canary-hook"',
      ].map((problem) => `${where}: ${problem}`),
    );
  });

  it('catches Git reads of forbidden paths at the mounted revision', async () => {
    const scenario = securityScenario('non-default-base');
    const reads = new SecurityScenarioRunner(
      scenario,
      async ({ processRunner, revision }) => {
        await processRunner.run(
          ...normativeGit(['cat-file', '-p', `${revision}:AGENTS.md`]),
        );
        await processRunner.run(
          ...normativeGit(['cat-file', '--batch'], 'pull/113/head:AGENTS.md\n'),
        );
        await processRunner.run(
          ...normativeGit([
            'diff',
            'release/1.x',
            'feature',
            '--',
            ':(literal).github',
          ]),
        );
        await processRunner.run(
          ...normativeGit([
            'grep',
            '-F',
            '-e',
            'x',
            `${revision}^{tree}`,
            '--',
            '.',
          ]),
        );
      },
    );
    expect(
      await violations(
        reads.assertNeverReads([...scenario.expectations.neverRead]),
      ),
    ).toHaveLength(4);
  });

  it('allows Git reads at other revisions and name-only Git commands', async () => {
    const scenario = securityScenario('non-default-base');
    const reads = new SecurityScenarioRunner(
      scenario,
      async ({ processRunner, revision }) => {
        await processRunner.run(
          ...normativeGit(['cat-file', '-p', 'release/1.x:AGENTS.md']),
        );
        await processRunner.run(
          ...normativeGit(['cat-file', '-p', `${revision}:`]),
        );
        await processRunner.run(
          ...normativeGit(['cat-file', '-p', `${revision}:src/db.ts`]),
        );
        await processRunner.run(
          ...normativeGit([
            'diff',
            '--name-only',
            'release',
            revision,
            '--',
            'AGENTS.md',
          ]),
        );
        await processRunner.run(
          ...normativeGit(['ls-tree', revision, '--', 'AGENTS.md']),
        );
        await processRunner.run(
          ...normativeGit(['diff', 'release', revision, '--', ':!AGENTS.md']),
        );
        await processRunner.run('git', ['--version']);
      },
    );
    await expect(
      reads.assertNeverReads([...scenario.expectations.neverRead]),
    ).resolves.toBeUndefined();
  });

  it('catches a shell, an untrusted executable, and option injection', async () => {
    const scenario = runner(
      'shell-metacharacters',
      async ({ processRunner }) => {
        await processRunner.run(
          'git log -- src/$(touch prism-canary-subshell).ts',
          [],
          { shell: true },
        );
        await processRunner.run('/repo/.githooks/post-checkout');
        await processRunner.run('git', [
          'diff',
          '--output=prism-canary-output.ts',
        ]);
      },
    );
    expect(await violations(scenario.assertNeverExecutes())).toEqual([
      '"git log -- src/$(touch prism-canary-subshell).ts" "": runs through a shell',
      '"git log -- src/$(touch prism-canary-subshell).ts" "": runs an executable outside the trusted list',
      '"git log -- src/$(touch prism-canary-subshell).ts" "": carries the planted command "prism-canary-subshell"',
      '"/repo/.githooks/post-checkout" "": runs an executable outside the trusted list',
      '"git" "diff --output=prism-canary-output.ts": passes the repository name "--output=prism-canary-output.ts" as an option',
    ]);
  });

  it('catches Git options and settings that run a program', async () => {
    const scenario = runner(
      'git-config-and-filters',
      async ({ processRunner }) => {
        await processRunner.run('git', ['diff', '--ext-diff']);
        await processRunner.run('git', [
          '-c',
          'filter.prism.clean=touch /tmp/prism-canary-clean',
          '-c',
          'core.hooksPath',
          'cat-file',
        ]);
        await processRunner.run('git', ['fetch', '-c']);
        await processRunner.run('git', ['status'], {
          env: {
            GIT_SSH_COMMAND: 'touch /tmp/prism-canary-hook',
            GIT_PAGER: '',
            GIT_CONFIG_KEY_0: 'core.fsmonitor',
            GIT_CONFIG_VALUE_0: 'touch /tmp/prism-canary-fsmonitor',
            GIT_CONFIG_KEY_1: 'diff.prism.textconv',
            GIT_CONFIG_VALUE_1: 'cat',
          },
        });
      },
    );
    const found = await violations(scenario.assertNeverExecutes());
    expect(found).toEqual([
      '"git" "diff --ext-diff": passes "--ext-diff", which runs a program',
      '"git" "-c filter.prism.clean=touch /tmp/prism-canary-clean -c core.hooksPath cat-file": sets "filter.prism.clean", which runs a program',
      '"git" "-c filter.prism.clean=touch /tmp/prism-canary-clean -c core.hooksPath cat-file": sets "core.hooksPath", which runs a program',
      '"git" "-c filter.prism.clean=touch /tmp/prism-canary-clean -c core.hooksPath cat-file": carries the planted command "prism-canary-clean"',
      '"git" "status": sets GIT_SSH_COMMAND, which runs a program',
      '"git" "status": sets "core.fsmonitor", which runs a program',
      '"git" "status": sets "diff.prism.textconv", which runs a program',
      '"git" "status": carries the planted command "prism-canary-fsmonitor"',
      '"git" "status": carries the planted command "prism-canary-hook"',
    ]);
  });

  it('accepts a caller-supplied list of trusted executables', async () => {
    const scenario = new SecurityScenarioRunner(
      securityScenario('lfs-pointer'),
      async ({ processRunner }) => {
        await processRunner.run('/usr/bin/git', ['status']);
      },
      { trustedExecutables: ['/usr/bin/git'] },
    );
    await expect(scenario.assertNeverExecutes()).resolves.toBeUndefined();
  });

  it('passes scripted process output to the subject', async () => {
    let seen = '';
    const scenario = new SecurityScenarioRunner(
      securityScenario('lfs-pointer'),
      async ({ processRunner }) => {
        seen = (await processRunner.run('git', ['rev-parse', 'HEAD'])).stdout;
      },
      { responder: () => ({ exitCode: 0, stdout: 'abc\n', stderr: '' }) },
    );
    await scenario.assertNeverExecutes();
    expect(seen).toBe('abc\n');
  });
});
