import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  securityScenario,
  securityScenarios,
} from '../../evals/fixtures/security/scenarios.ts';
import type { SecurityScenario } from '../../evals/fixtures/security/types.ts';
import {
  buildSecurityFixtures,
  main,
  renderPayloads,
} from './buildSecurityFixtures.ts';
import { buildRepository } from '../../evals/fixtures/security/repositoryObjects.ts';

const scratch = mkdtempSync(path.join(tmpdir(), 'prism-corpus-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let next = 0;
const freshDirectory = () => path.join(scratch, `out-${(next += 1)}`);

// Every file below a directory, keyed by relative path.
function snapshot(directory: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(directory, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    files[path.relative(directory, file)] =
      readFileSync(file).toString('base64');
  }
  return files;
}

const payloads = (id: string) => {
  const scenario = securityScenario(id);
  return renderPayloads(scenario, buildRepository(scenario.repository)) as {
    event: {
      pull_request: {
        base: { ref: string; sha: string };
        head: { sha: string };
      };
      repository: { default_branch: string };
    };
    files: { filename: string; status: string }[];
    compare: {
      status: string;
      base_commit: { sha: string };
      merge_base_commit: { sha: string };
    };
    reviewComments: { id: number; in_reply_to_id?: number; body: string }[];
    issueComments: { id: number; body: string }[];
  };
};

describe('buildSecurityFixtures', () => {
  it('writes byte-identical output on every build', () => {
    const first = freshDirectory();
    const second = freshDirectory();
    const manifest = buildSecurityFixtures(first);
    buildSecurityFixtures(second);
    expect(snapshot(second)).toEqual(snapshot(first));
    expect(manifest.map((item) => item.id)).toEqual(
      securityScenarios.map((item) => item.id),
    );
    const written = JSON.parse(
      readFileSync(path.join(first, 'manifest.json'), 'utf8'),
    ) as unknown;
    expect(written).toEqual(manifest);
    expect(
      readdirSync(path.join(first, 'credentials', 'payloads')).sort(),
    ).toEqual([
      'compare.json',
      'event.json',
      'files.json',
      'issueComments.json',
      'reviewComments.json',
    ]);
  });

  it('refuses a directory that is not empty', () => {
    const directory = freshDirectory();
    mkdirSync(directory);
    writeFileSync(path.join(directory, 'keep'), '');
    expect(() => buildSecurityFixtures(directory, [])).toThrow(/not empty/);
  });

  it('accepts an existing empty directory', () => {
    const directory = freshDirectory();
    mkdirSync(directory);
    expect(buildSecurityFixtures(directory, [])).toEqual([]);
  });

  it('refuses a repeated or unsafe scenario ID', () => {
    const scenario = securityScenario('lfs-pointer');
    expect(() =>
      buildSecurityFixtures(freshDirectory(), [scenario, scenario]),
    ).toThrow(/invalid or repeated/);
    const unsafe: SecurityScenario = { ...scenario, id: '../escape' };
    expect(() => buildSecurityFixtures(freshDirectory(), [unsafe])).toThrow(
      /invalid or repeated/,
    );
  });
});

describe('renderPayloads', () => {
  it('lists the three-dot changes and the merge-base of a diverged head', () => {
    const { files, compare, event } = payloads('diverged-head');
    expect(files).toEqual([{ filename: 'src/math.ts', status: 'modified' }]);
    expect(compare.status).toBe('diverged');
    expect(compare.merge_base_commit.sha).not.toBe(compare.base_commit.sha);
    expect(event.pull_request.base.sha).toBe(compare.base_commit.sha);
  });

  it('targets a base branch other than the default branch', () => {
    const { event, compare } = payloads('non-default-base');
    expect(event.pull_request.base.ref).toBe('release/1.x');
    expect(event.repository.default_branch).toBe('main');
    expect(compare.status).toBe('ahead');
  });

  it('adds names Git cannot store to the changed-files payload', () => {
    const { files } = payloads('hostile-names');
    expect(files.map((file) => file.filename)).toContain(
      'src/a.ts\u0000../../etc/passwd',
    );
  });

  it('splits thread replies from conversation comments', () => {
    const injection = payloads('prompt-injection');
    expect(injection.reviewComments.map((comment) => comment.id)).toEqual([
      9001, 9002, 9003,
    ]);
    expect(injection.reviewComments[0]).not.toHaveProperty('in_reply_to_id');
    expect(injection.reviewComments[1]?.in_reply_to_id).toBe(9001);
    expect(injection.issueComments).toEqual([]);
    expect(payloads('credentials').issueComments).toHaveLength(1);
  });

  it('refuses a pull request that names an unknown commit', () => {
    const scenario = securityScenario('lfs-pointer');
    const broken: SecurityScenario = {
      ...scenario,
      pullRequest: { ...scenario.pullRequest, head: 'missing' },
    };
    expect(() =>
      renderPayloads(broken, buildRepository(scenario.repository)),
    ).toThrow(/Unknown commit label missing/);
  });
});

describe('main', () => {
  const io = () => ({ log: vi.fn(), error: vi.fn() });

  it('builds into the named directory', () => {
    const streams = io();
    const directory = freshDirectory();
    expect(main([directory], streams)).toBe(0);
    expect(streams.log).toHaveBeenCalledWith(
      `Wrote ${securityScenarios.length} security scenarios to ${directory}.`,
    );
  });

  it('prints usage without exactly one argument', () => {
    const streams = io();
    expect(main([], streams)).toBe(2);
    expect(main(['a', 'b'], streams)).toBe(2);
    expect(streams.error).toHaveBeenCalledTimes(2);
  });

  it('reports a failed build', () => {
    const streams = io();
    const directory = freshDirectory();
    mkdirSync(directory);
    writeFileSync(path.join(directory, 'keep'), '');
    expect(main([directory], streams)).toBe(1);
    expect(streams.error).toHaveBeenCalledWith(`${directory} is not empty.`);
  });
});
