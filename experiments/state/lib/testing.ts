// Shared setup for the spike's tests: a fake pull request with a publisher,
// an attacker, a maintainer and a writer, and a model that counts calls.
// Account ids are synthetic.
import { FakeGitHub } from './github.ts';
import type { Account, CommentChannel } from './github.ts';
import type { ReviewKeyInput } from './keys.ts';
import { findEffectMarkers } from './marker.ts';
import type { InferenceResult, ModelPort, RunContext } from './protocol.ts';
import type { ExpectedPublisher } from './publisher.ts';
import type { PublicationConfig } from './record.ts';

export const headA = 'a'.repeat(40);
export const headB = 'b'.repeat(40);
export const identity = { repoId: 7001, prNumber: 42 };

export const accounts = {
  actions: { login: 'github-actions[bot]', id: 1001, type: 'Bot' },
  app: { login: 'prismatic-review[bot]', id: 1002, type: 'Bot' },
  personal: { login: 'cli-user', id: 1003, type: 'User' },
  mallory: { login: 'mallory', id: 1004, type: 'User' },
  maintainer: { login: 'maya', id: 1005, type: 'User' },
  writer: { login: 'wes', id: 1006, type: 'User' },
} as const satisfies Record<string, Account>;

export function pullRequest(): FakeGitHub {
  const github = new FakeGitHub(headA);
  github.addAccount(accounts.actions, 'write');
  github.addAccount(accounts.app, 'write');
  github.addAccount(accounts.personal, 'admin');
  github.addAccount(accounts.mallory, 'read');
  github.addAccount(accounts.maintainer, 'maintain');
  github.addAccount(accounts.writer, 'write');
  return github;
}

export function publisherFor(account: Account): ExpectedPublisher {
  return { login: account.login, id: account.id, source: 'actions-token' };
}

export function review(headSha = headA): ReviewKeyInput {
  return {
    repoId: identity.repoId,
    prNumber: identity.prNumber,
    baseRepoId: identity.repoId,
    baseRefName: 'main',
    mergeBaseSha: 'c'.repeat(40),
    headSha,
    configDigest: 'd'.repeat(64),
    reviewerVersion: 'spike-1',
  };
}

export const usage = {
  inputTokens: 1_000,
  outputTokens: 200,
  costMicroUsd: 4_000,
};

export function completed(
  findingCount: number,
  bodyChars = 80,
): InferenceResult {
  return {
    kind: 'completed',
    outcome: findingCount === 0 ? 'approve' : 'revise',
    findings: Array.from({ length: findingCount }, (_, index) => ({
      title: `Finding ${index}`,
      body: filler(index, bodyChars),
      anchor: { path: `src/file${index}.ts`, line: index + 1 },
    })),
    coverage: { reviewed: 3, unreviewed: 0 },
    usage,
  };
}

// Text that deflate cannot shrink much, so a few findings fill shards.
export function filler(seed: number, chars: number): string {
  let text = '';
  let state = seed * 2_654_435_761 + 1;
  while (text.length < chars) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    text += state.toString(36);
  }
  return text.slice(0, chars);
}

export class FakeModel implements ModelPort {
  calls = 0;
  readonly #results: (InferenceResult | 'unknown')[];

  constructor(...results: (InferenceResult | 'unknown')[]) {
    this.#results = results;
  }

  async infer(): Promise<InferenceResult> {
    const result =
      this.#results[Math.min(this.calls, this.#results.length - 1)];
    this.calls += 1;
    if (result === undefined || result === 'unknown') {
      throw new Error('The provider connection reset.');
    }
    return result;
  }
}

export interface Harness {
  readonly github: FakeGitHub;
  readonly model: FakeModel;
  context(overrides?: Partial<RunContext>): RunContext;
}

export function harness(
  config: PublicationConfig,
  model: FakeModel,
  publisher: Account = accounts.actions,
): Harness {
  const github = pullRequest();
  return {
    github,
    model,
    context: (overrides = {}) => ({
      github: github.client(publisher.login, 'installation'),
      publisher: publisherFor(publisher),
      identity,
      config,
      model,
      ...overrides,
    }),
  };
}

// How many comments in a channel carry each effect id.
export function effectCounts(
  github: FakeGitHub,
  channel: CommentChannel,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const comment of github.comments(channel)) {
    for (const marker of findEffectMarkers(comment.body)) {
      counts.set(marker.effectId, (counts.get(marker.effectId) ?? 0) + 1);
    }
  }
  return counts;
}

export const allOn: PublicationConfig = {
  publishInline: true,
  progressComments: 'always',
};

export const allOff: PublicationConfig = {
  publishInline: false,
  progressComments: 'never',
};
