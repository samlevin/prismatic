// Builds the adversarial corpus in evals/fixtures/security/ into an output
// directory: one bare Git repository and a set of GitHub payloads per
// scenario, plus a manifest of every object ID. The output is generated, not
// committed, and the same scenarios always produce the same bytes.
//
//   node tooling/scripts/buildSecurityFixtures.ts <output-directory>
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pullRequestChanges } from '../../evals/fixtures/security/history.ts';
import { securityScenarios } from '../../evals/fixtures/security/scenarios.ts';
import type { SecurityScenario } from '../../evals/fixtures/security/types.ts';
import {
  buildRepository,
  writeBareRepository,
  type BuiltRepository,
} from './fixtureRepository.ts';

export const baseRepositoryName = 'acme/widgets';

export interface ScenarioPayloads {
  // A pull_request `opened` webhook event.
  readonly event: unknown;
  // The pull request's changed files, as the REST files endpoint lists them.
  readonly files: unknown;
  // The compare API response for base tip and head.
  readonly compare: unknown;
  readonly reviewComments: unknown;
  readonly issueComments: unknown;
}

export interface ScenarioManifest {
  readonly id: string;
  readonly summary: string;
  readonly covers: readonly string[];
  readonly commits: Readonly<Record<string, string>>;
  readonly refs: Readonly<Record<string, string>>;
  readonly pullRequest: {
    readonly number: number;
    readonly base: string;
    readonly head: string;
    readonly mergeBase: string;
  };
  readonly expectations: SecurityScenario['expectations'];
}

function commitId(built: BuiltRepository, label: string): string {
  const id = built.commits[label];
  if (id === undefined) throw new Error(`Unknown commit label ${label}.`);
  return id;
}

export function renderPayloads(
  scenario: SecurityScenario,
  built: BuiltRepository,
): ScenarioPayloads {
  const pull = scenario.pullRequest;
  const headSha = commitId(built, pull.head);
  const fork = `${pull.author}/${baseRepositoryName.split('/')[1] ?? ''}`;
  const repository = {
    full_name: baseRepositoryName,
    default_branch: scenario.repository.defaultBranch,
  };
  const user = (login: string) => ({ login });
  const thread = pull.replies.filter((reply) => reply.path !== null);
  const conversation = pull.replies.filter((reply) => reply.path === null);
  return {
    event: {
      action: 'opened',
      number: pull.number,
      pull_request: {
        number: pull.number,
        title: pull.title,
        body: pull.body,
        user: user(pull.author),
        base: {
          ref: pull.baseRef,
          sha: commitId(built, pull.base),
          repo: repository,
        },
        head: {
          ref: pull.headRef,
          sha: headSha,
          repo: { full_name: fork, fork: true },
        },
      },
      repository,
      sender: user(pull.author),
    },
    files: [
      ...pullRequestChanges(scenario).map(({ path: filename, status }) => ({
        filename,
        status,
      })),
      ...(pull.extraFileNames ?? []).map((filename) => ({
        filename,
        status: 'added',
      })),
    ],
    compare: {
      status: pull.base === pull.mergeBase ? 'ahead' : 'diverged',
      base_commit: { sha: commitId(built, pull.base) },
      merge_base_commit: { sha: commitId(built, pull.mergeBase) },
    },
    reviewComments: thread.map((reply) => ({
      id: reply.id,
      ...(reply.inReplyTo === null ? {} : { in_reply_to_id: reply.inReplyTo }),
      user: user(reply.author),
      path: reply.path,
      commit_id: headSha,
      body: reply.body,
    })),
    issueComments: conversation.map((reply) => ({
      id: reply.id,
      user: user(reply.author),
      body: reply.body,
    })),
  };
}

export function scenarioManifest(
  scenario: SecurityScenario,
  built: BuiltRepository,
): ScenarioManifest {
  const pull = scenario.pullRequest;
  return {
    id: scenario.id,
    summary: scenario.summary,
    covers: scenario.covers,
    commits: built.commits,
    refs: built.refs,
    pullRequest: {
      number: pull.number,
      base: commitId(built, pull.base),
      head: commitId(built, pull.head),
      mergeBase: commitId(built, pull.mergeBase),
    },
    expectations: scenario.expectations,
  };
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

// Writes every scenario below `directory`, which must not exist yet or be
// empty, and returns the manifest it wrote.
export function buildSecurityFixtures(
  directory: string,
  scenarios: readonly SecurityScenario[] = securityScenarios,
): readonly ScenarioManifest[] {
  if (existsSync(directory) && readdirSync(directory).length > 0) {
    throw new Error(`${directory} is not empty.`);
  }
  const ids = new Set<string>();
  const manifest: ScenarioManifest[] = [];
  for (const scenario of scenarios) {
    if (
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(scenario.id) ||
      ids.has(scenario.id)
    ) {
      throw new Error(
        `Scenario ID ${JSON.stringify(scenario.id)} is invalid or repeated.`,
      );
    }
    ids.add(scenario.id);
    const built = buildRepository(scenario.repository);
    const root = path.join(directory, scenario.id);
    writeBareRepository(path.join(root, 'repo.git'), built);
    const payloads = renderPayloads(scenario, built);
    mkdirSync(path.join(root, 'payloads'), { recursive: true });
    for (const [name, value] of Object.entries(payloads)) {
      writeFileSync(path.join(root, 'payloads', `${name}.json`), json(value));
    }
    manifest.push(scenarioManifest(scenario, built));
  }
  writeFileSync(path.join(directory, 'manifest.json'), json(manifest));
  return manifest;
}

export interface BuilderIo {
  readonly log: (message: string) => void;
  readonly error: (message: string) => void;
}

const processIo: BuilderIo = {
  log: (message) => console.log(message),
  error: (message) => console.error(message),
};

// Command line entry. Returns the process exit code.
export function main(
  args: readonly string[],
  io: BuilderIo = processIo,
): number {
  const [directory, ...rest] = args;
  if (directory === undefined || rest.length > 0) {
    io.error(
      'Usage: node tooling/scripts/buildSecurityFixtures.ts <output-directory>',
    );
    return 2;
  }
  try {
    const manifest = buildSecurityFixtures(path.resolve(directory));
    io.log(`Wrote ${manifest.length} security scenarios to ${directory}.`);
    return 0;
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
