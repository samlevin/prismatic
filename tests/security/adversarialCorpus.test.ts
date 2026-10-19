// Security cases drawn from the adversarial corpus in evals/fixtures/security/:
// the shared primitives against the names, text, and credentials a hostile
// pull request carries, and the scenario runner against a careless reader.
import { describe, expect, it } from 'vitest';
import {
  pullRequestChanges,
  treeAt,
} from '../../evals/fixtures/security/history.ts';
import { credentialSamples } from '../../evals/fixtures/security/credentials.ts';
import {
  securityScenario,
  securityScenarios,
  shellMetacharacterNames,
} from '../../evals/fixtures/security/scenarios.ts';
import { SecurityScenarioRunner } from '../../evals/SecurityScenarioRunner.ts';
import { escapeMarkdown } from '../../src/shared/markdown.ts';
import {
  findNormalizationCollisions,
  normalizeRepoPath,
} from '../../src/shared/path.ts';
import { redactSecrets } from '../../src/shared/redaction.ts';

const accepts = (path: string): boolean => {
  try {
    return normalizeRepoPath(path) === path;
  } catch {
    return false;
  }
};

describe('hostile names from the corpus', () => {
  const scenario = securityScenario('hostile-names');
  const names = [
    ...pullRequestChanges(scenario).map((change) => change.path),
    ...(scenario.pullRequest.extraFileNames ?? []),
  ];

  it.each([
    'src/../../escape.ts',
    '../outside.ts',
    'sub/.GIT/config',
    'GIT~1/config',
    'src/..\\..\\escape.ts',
    'C:\\windows.ts',
    'src/invoice\u202Est.ts',
    'src/line\nbreak.ts',
    'src/a.ts\u0000../../etc/passwd',
    'src/nul\u0000.ts',
    '/etc/passwd',
    '../../outside.ts',
  ])('normalizeRepoPath refuses %j', (name) => {
    expect(names).toContain(name);
    expect(accepts(name)).toBe(false);
  });

  it('keeps every name it accepts byte for byte and finds the normalization collision', () => {
    const accepted = names.filter(accepts);
    expect(accepted.length).toBeGreaterThan(0);
    expect(findNormalizationCollisions(accepted)).toEqual([
      ['src/cafe\u0301', 'src/caf\u00E9'],
      ['src/cafe\u0301/handler.ts', 'src/caf\u00E9/handler.ts'],
    ]);
  });

  it('accepts shell metacharacters as data', () => {
    for (const name of shellMetacharacterNames)
      expect(accepts(name)).toBe(true);
  });
});

describe('injected pull request text from the corpus', () => {
  const { pullRequest } = securityScenario('prompt-injection');
  const texts = [
    pullRequest.title,
    pullRequest.body,
    ...pullRequest.replies.map((reply) => reply.body),
  ];

  it.each(texts.map((text, index) => [index, text] as const))(
    'escapeMarkdown renders text %i inert',
    (_index, text) => {
      const rendered = escapeMarkdown(text);
      expect(rendered).not.toMatch(/[<>\n]/);
      expect(rendered).not.toContain('](');
      expect(rendered).not.toMatch(/@(?!&#8203;)/);
    },
  );
});

describe('credentials from the corpus', () => {
  const scenario = securityScenario('credentials');
  const shaped = credentialSamples
    .filter((sample) => sample.shape === 'credential')
    .map((sample) => sample.value);

  it('redactSecrets leaves no committed credential in the changed files', () => {
    const tree = treeAt(scenario.repository, scenario.pullRequest.head);
    const contents = pullRequestChanges(scenario)
      .map(({ path }) => tree[path])
      .map((entry) =>
        entry?.kind === 'file' ? Buffer.from(entry.content).toString() : '',
      )
      .join('\n');
    const masked = String(redactSecrets(contents));
    for (const value of shaped) {
      if (contents.includes(value)) expect(masked).not.toContain(value);
    }
  });

  it('redactSecrets masks credentials pasted into the body and replies', () => {
    const { pullRequest } = scenario;
    const text = [pullRequest.body, ...pullRequest.replies.map((r) => r.body)];
    const masked = JSON.stringify(redactSecrets(text));
    expect(
      shaped.filter((value) => text.join('\n').includes(value)),
    ).toHaveLength(2);
    for (const value of shaped) expect(masked).not.toContain(value);
  });
});

describe('a careless reader against the corpus', () => {
  // Reads every name the pull request reports, following symlinks, which is
  // what the eligibility and path guard layers exist to prevent.
  const careless = new Map(
    securityScenarios
      .filter((scenario) => scenario.expectations.neverRead.length > 0)
      .map((scenario) => [
        scenario.id,
        new SecurityScenarioRunner(scenario, async ({ fileSystem }) => {
          const names = [
            ...pullRequestChanges(scenario).map((change) => change.path),
            ...(scenario.pullRequest.extraFileNames ?? []),
          ];
          for (const name of names) {
            await fileSystem.readFile(name).catch(() => undefined);
          }
        }),
      ]),
  );

  it.each([...careless.keys()])(
    'is caught reading what %s forbids',
    async (id) => {
      const scenario = securityScenario(id);
      await expect(
        careless
          .get(id)
          ?.assertNeverReads([...scenario.expectations.neverRead]),
      ).rejects.toThrow(/reads forbidden/);
    },
  );

  it('is caught passing a hostile name to Git before --', async () => {
    const scenario = securityScenario('shell-metacharacters');
    const runner = new SecurityScenarioRunner(
      scenario,
      async ({ processRunner }) => {
        for (const { path } of pullRequestChanges(scenario)) {
          await processRunner.run('git', ['log', path]);
        }
      },
    );
    await expect(runner.assertNeverExecutes()).rejects.toThrow(
      /passes the repository name "--upload-pack=touch prism-canary-option.ts" as an option/,
    );
  });
});
