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
    expect(await processes.run('git', args, { env })).toEqual({
      exitCode: 3,
      stdout: 'a,b',
      stderr: '',
    });
    args.push('c');
    env.X = '2';
    expect(processes.requests).toEqual([
      { command: 'git', args: ['a', 'b'], options: { env: { X: '1' } } },
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
      await fileSystem.readFile('lib/../.env', { noFollow: true });
    });
    expect(await violations(scenario.assertNeverReads(['.env']))).toHaveLength(
      1,
    );
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
  it('passes literal pathspecs after -- with hooks and filters turned off', async () => {
    const scenario = runner(
      'shell-metacharacters',
      async ({ processRunner }) => {
        await processRunner.run(
          'git',
          [
            '-c',
            'core.hooksPath=/dev/null',
            '-c',
            'core.fsmonitor=false',
            '-c',
            'diff.external=',
            '-c',
            'protocol.allow=never',
            'diff',
            '--no-ext-diff',
            '--no-textconv',
            '--',
            '--upload-pack=touch prism-canary-option.ts',
            'src/$(touch prism-canary-subshell).ts',
          ],
          {
            shell: false,
            env: {
              GIT_CONFIG_KEY_0: 'credential.helper',
              GIT_CONFIG_VALUE_0: '',
            },
          },
        );
      },
    );
    await expect(scenario.assertNeverExecutes()).resolves.toBeUndefined();
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
