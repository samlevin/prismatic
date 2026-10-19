import { createPrivateKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { redactSecrets } from '../../../src/shared/redaction.ts';
import { hostFiles } from '../../SecurityScenarioRunner.ts';
import {
  credentialSample,
  credentialSamples,
  githubToken,
  hasValidGitHubChecksum,
  privateKeyPem,
} from './credentials.ts';
import {
  diffTrees,
  pullRequestChanges,
  resolveTrees,
  treeAt,
} from './history.ts';
import { securityScenario, securityScenarios } from './scenarios.ts';
import { corpusCoverageItems, type FixtureRepository } from './types.ts';

describe('the corpus', () => {
  it('covers every acceptance item', () => {
    const covered = new Set(securityScenarios.flatMap((item) => item.covers));
    expect(
      [...corpusCoverageItems].filter((item) => !covered.has(item)),
    ).toEqual([]);
  });

  it('gives every scenario a unique ID and pull request number', () => {
    const ids = securityScenarios.map((item) => item.id);
    const numbers = securityScenarios.map((item) => item.pullRequest.number);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it.each(securityScenarios.map((item) => [item.id, item] as const))(
    '%s names paths and commits that exist',
    (_id, scenario) => {
      const trees = resolveTrees(scenario.repository);
      const { base, head, mergeBase, number } = scenario.pullRequest;
      for (const label of [base, head, mergeBase]) {
        expect(trees.has(label)).toBe(true);
      }
      expect(scenario.repository.refs[`refs/pull/${number}/head`]).toBe(head);
      const headPaths = Object.keys(trees.get(head) ?? {});
      for (const forbidden of scenario.expectations.neverRead) {
        const exists = forbidden.startsWith('/')
          ? forbidden in hostFiles
          : headPaths.some(
              (path) => path === forbidden || path.startsWith(`${forbidden}/`),
            );
        expect(exists, forbidden).toBe(true);
      }
      expect(pullRequestChanges(scenario).length).toBeGreaterThan(0);
    },
  );

  it('plants every execution canary in the repository or its names', () => {
    for (const scenario of securityScenarios) {
      const text = Object.entries(
        treeAt(scenario.repository, scenario.pullRequest.head),
      )
        .map(([path, entry]) =>
          entry.kind === 'file'
            ? `${path}\n${Buffer.from(entry.content).toString()}`
            : path,
        )
        .join('\n');
      for (const canary of scenario.expectations.executionCanaries) {
        expect(text, `${scenario.id} ${canary}`).toContain(canary);
      }
    }
  });

  it('makes a two-dot diff from the base tip wrong for the diverged head', () => {
    const scenario = securityScenario('diverged-head');
    const { base, head } = scenario.pullRequest;
    const twoDot = diffTrees(
      treeAt(scenario.repository, base),
      treeAt(scenario.repository, head),
    ).map((change) => change.path);
    const threeDot = pullRequestChanges(scenario).map((change) => change.path);
    expect(threeDot).toEqual(['src/math.ts']);
    expect(twoDot).toEqual([
      'src/math.ts',
      'src/new-on-main.ts',
      'src/util.ts',
    ]);
  });

  it('carries different rules on the base branch than on the default branch', () => {
    const { repository, pullRequest } = securityScenario('non-default-base');
    const rules = (label: string) =>
      treeAt(repository, label)['.github/pr-review-agent.yml'];
    const defaultTip =
      repository.refs[`refs/heads/${repository.defaultBranch}`];
    expect(pullRequest.baseRef).not.toBe(repository.defaultBranch);
    expect(rules(pullRequest.base)).not.toEqual(rules(defaultTip ?? ''));
    expect(rules(pullRequest.head)).not.toEqual(rules(pullRequest.base));
  });

  it('hides a reviewable change behind an ignore rule added in the same pull request', () => {
    const changes = pullRequestChanges(
      securityScenario('gitignore-hides-change'),
    );
    expect(changes.map((change) => change.path)).toEqual([
      '.gitignore',
      'build/bundle.js',
      'src/auth.ts',
    ]);
  });
});

describe('credential samples', () => {
  it('has a credential-shaped and a benign sample for every detector row', () => {
    for (const row of [
      'github-token',
      'saas-secret',
      'aws-access-key-id',
      'private-key',
      'connection-string',
      'masked-only',
    ]) {
      const shapes = credentialSamples
        .filter((sample) => sample.row === row)
        .map((sample) => sample.shape);
      expect(shapes, row).toContain('credential');
      expect(shapes, row).toContain('benign');
    }
  });

  it('builds a checksum-valid GitHub token and a benign one that fails the check', () => {
    expect(
      hasValidGitHubChecksum(
        credentialSample('github token, valid checksum').value,
      ),
    ).toBe(true);
    expect(
      hasValidGitHubChecksum(
        credentialSample('github token, wrong checksum').value,
      ),
    ).toBe(false);
    expect(hasValidGitHubChecksum('ghp_short')).toBe(false);
    expect(hasValidGitHubChecksum(githubToken(1, 'gho'))).toBe(true);
  });

  it('builds a private key that parses and a benign block that does not', () => {
    const key = createPrivateKey(credentialSample('ed25519 private key').value);
    expect(key.asymmetricKeyType).toBe('ed25519');
    expect(() =>
      createPrivateKey(
        credentialSample('private key armor around prose').value,
      ),
    ).toThrow();
  });

  it('builds the same values from the same seed', () => {
    expect(githubToken(21)).toBe(
      credentialSample('github token, valid checksum').value,
    );
    expect(privateKeyPem(32)).toBe(
      credentialSample('ed25519 private key').value,
    );
    expect(githubToken(21)).not.toBe(githubToken(22));
  });

  it.each(
    credentialSamples
      .filter(
        (sample) =>
          sample.shape === 'credential' && sample.row !== 'masked-only',
      )
      .map((sample) => [sample.name, sample.value] as const),
  )('redactSecrets masks the %s', (_name, value) => {
    expect(String(redactSecrets(`value = ${value}`))).not.toContain(value);
  });

  it('refuses an unknown sample name', () => {
    expect(() => credentialSample('nope')).toThrow(/No credential sample/);
  });
});

describe('history', () => {
  const repository = (
    commits: FixtureRepository['commits'],
  ): FixtureRepository => ({
    defaultBranch: 'main',
    commits,
    refs: {},
  });

  it('refuses a repeated label and an unknown parent', () => {
    const commit = { label: 'a', parents: [], message: 'm', changes: {} };
    expect(() => resolveTrees(repository([commit, commit]))).toThrow(
      /used twice/,
    );
    expect(() =>
      resolveTrees(repository([{ ...commit, parents: ['ghost'] }])),
    ).toThrow(/unknown parent ghost/);
    expect(() => treeAt(repository([commit]), 'b')).toThrow(
      /Unknown commit label b/,
    );
    expect(() => securityScenario('nope')).toThrow(/No security scenario/);
  });

  it('deletes a path whose change is null and reports every kind of change', () => {
    const file = (content: string) => ({ kind: 'file', content }) as const;
    const history = repository([
      {
        label: 'a',
        parents: [],
        message: 'm',
        changes: {
          gone: file('x'),
          same: file('x'),
          mode: file('x'),
          link: { kind: 'symlink', target: 'a' },
          module: { kind: 'submodule', commit: 'a'.repeat(40) },
          retyped: file('x'),
        },
      },
      {
        label: 'b',
        parents: ['a'],
        message: 'm',
        changes: {
          gone: null,
          added: file('y'),
          mode: { kind: 'file', content: 'x', executable: true },
          link: { kind: 'symlink', target: 'b' },
          module: { kind: 'submodule', commit: 'b'.repeat(40) },
          retyped: { kind: 'symlink', target: 'x' },
        },
      },
    ]);
    const trees = resolveTrees(history);
    expect(diffTrees(trees.get('a') ?? {}, trees.get('b') ?? {})).toEqual([
      { path: 'added', status: 'added' },
      { path: 'gone', status: 'removed' },
      { path: 'link', status: 'modified' },
      { path: 'mode', status: 'modified' },
      { path: 'module', status: 'modified' },
      { path: 'retyped', status: 'modified' },
    ]);
    expect(diffTrees(trees.get('a') ?? {}, trees.get('a') ?? {})).toEqual([]);
  });

  it('refuses a pull request that names an unknown commit', () => {
    const scenario = securityScenario('lfs-pointer');
    expect(() =>
      pullRequestChanges({
        ...scenario,
        pullRequest: { ...scenario.pullRequest, mergeBase: 'ghost' },
      }),
    ).toThrow(/Unknown commit label ghost/);
    expect(() =>
      pullRequestChanges({
        ...scenario,
        pullRequest: { ...scenario.pullRequest, head: 'ghost' },
      }),
    ).toThrow(/Unknown commit label ghost/);
  });
});
