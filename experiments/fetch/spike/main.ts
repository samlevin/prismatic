// Runs the scoped-fetch spike and prints the results as JSON on stdout.
// Progress goes to stderr. run-in-image.sh starts it inside the pinned
// Action image as the unprivileged user.
//
// Usage: node main.ts [--skip-large] [--github <owner/repo> <pr> <prior-sha>]
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Lab } from './lab.ts';
import {
  admissionScenario,
  ancestryScenario,
  backfillScenario,
  createReviewContext,
  inventoryScenario,
  lazyFetchScenario,
  negotiationScenario,
  noFullFetchScenario,
} from './scenarios.ts';
import { historyScenario } from './history.ts';
import { largeScenario } from './large.ts';
import { githubScenario } from './github.ts';
import type { ScenarioRecord } from './record.ts';

const gitPath = '/usr/local/bin/git';

async function main(argv: readonly string[]): Promise<number> {
  const skipLarge = argv.includes('--skip-large');
  const githubAt = argv.indexOf('--github');
  const github =
    githubAt === -1
      ? undefined
      : {
          repository: argv[githubAt + 1] ?? '',
          pullRequest: Number(argv[githubAt + 2]),
          priorHead: argv[githubAt + 3] ?? '',
        };
  const root = await mkdtemp(path.join(os.tmpdir(), 'prismatic-fetch-spike-'));
  const lab = await Lab.create(root, gitPath);
  const records: ScenarioRecord[] = [];
  const started = new Date();
  const log = (message: string): void => {
    process.stderr.write(`${new Date().toISOString()} ${message}\n`);
  };
  try {
    const version = (await lab.git.ok(root, ['--version'])).stdout
      .toString('utf8')
      .trim();
    log(version);
    const ctx = await createReviewContext(lab);
    for (const [name, scenario] of [
      ['raw-inventory', () => inventoryScenario(lab, ctx)],
      ['admission-and-acquisition', () => admissionScenario(lab, ctx)],
      ['acquisition-negotiation', () => negotiationScenario(lab, ctx)],
      ['backfill', () => backfillScenario(lab, ctx)],
      ['lazy-fetch-disabled', () => lazyFetchScenario(lab, ctx)],
      ['ancestry', () => ancestryScenario(lab, ctx)],
      ['history-cost', () => historyScenario(lab)],
      ...(skipLarge
        ? []
        : [['large-2gib-10-files', () => largeScenario(lab)] as const]),
    ] as const) {
      log(`scenario ${name}`);
      records.push(await scenario());
    }
    if (github) {
      log('scenario github-sandbox');
      const githubLab = await Lab.create(
        path.join(root, 'github'),
        gitPath,
        false,
      );
      records.push(await githubScenario(githubLab, github));
      records.push(
        noFullFetchScenario(
          githubLab,
          records.filter((r) => r.id === 'github-sandbox'),
        ),
      );
    }
    records.push(
      noFullFetchScenario(
        lab,
        records.filter(
          (r) => r.id !== 'github-sandbox' && r.id !== 'no-full-fetch',
        ),
      ),
    );
    process.stdout.write(
      `${JSON.stringify(
        {
          spike: 'P0.8 scoped fetch (#141)',
          git: version,
          node: process.version,
          platform: `${process.platform}/${process.arch}`,
          uid: process.getuid?.(),
          startedAt: started.toISOString(),
          finishedAt: new Date().toISOString(),
          passed: records.every((record) => record.passed),
          summary: records.map((record) => ({
            id: record.id,
            criteria: record.criteria,
            passed: record.passed,
            failed: record.checks.filter((c) => !c.passed).map((c) => c.name),
          })),
          scenarios: records,
        },
        null,
        2,
      )}\n`,
    );
    return records.every((record) => record.passed) ? 0 : 1;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

process.exitCode = await main(process.argv.slice(2));
