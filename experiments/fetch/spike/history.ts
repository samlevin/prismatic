// Preparation cost for the same three-line delta and the same affected
// findings, in PRs with little, much and maximal already-reviewed history.
// The union manifest (§5.4) carries every path changed since the
// merge-base, so its acquisition, parse and patch work can grow with history
// even when the delta does not. The narrowed plan acquires only the delta
// and the findings' evidence paths (no obligations are pending in this
// fixture, because every earlier round was fully reviewed).
import { sourceText } from '../lib/fixtures.ts';
import type { FixtureChange, FixtureCommit } from '../lib/fixtures.ts';
import type { Lab, Server } from './lab.ts';
import { prepare } from './prepare.ts';
import type { Preparation } from './prepare.ts';
import { ScenarioBuilder } from './record.ts';
import type { ScenarioRecord } from './record.ts';

const moduleCount = 600;
const moduleBytes = 6000;
// maxRounds is 12, so 11 reviewed rounds is the most history an automatic
// discovery round follows. `cap` reaches the §5.4 limit of 500 changed files.
const levels = {
  little: { rounds: 1, filesPerRound: 2 },
  much: { rounds: 11, filesPerRound: 11 },
  cap: { rounds: 11, filesPerRound: 45 },
} as const;
type Level = keyof typeof levels;
const levelNames = Object.keys(levels) as Level[];
const scopes = ['union', 'narrowed'] as const;
type Scope = (typeof scopes)[number];

const modulePath = (index: number): string =>
  `src/m${String(index).padStart(3, '0')}.ts`;

const roundContent = (index: number): string =>
  sourceText(`m${index} round`, moduleBytes);

function delta(): FixtureChange {
  return {
    path: modulePath(0),
    content: `${roundContent(0)}// delta 1\n// delta 2\n// delta 3\n`,
  };
}

interface Branch {
  readonly head: number;
  readonly frontier: number;
}

function historyFixture(): {
  commits: FixtureCommit[];
  branches: Record<Level, Branch>;
} {
  const base: FixtureChange[] = [];
  for (let index = 0; index < moduleCount; index += 1)
    base.push({
      path: modulePath(index),
      content: sourceText(`m${index}`, moduleBytes),
    });
  const commits: FixtureCommit[] = [
    {
      mark: 1,
      ref: 'refs/heads/main',
      parents: [],
      message: 'base',
      changes: base,
    },
  ];
  const branches = {} as Record<Level, Branch>;
  let mark = 10;
  for (const level of levelNames) {
    const { rounds, filesPerRound } = levels[level];
    let parent = 1;
    let next = 2;
    for (let round = 0; round < rounds; round += 1) {
      // Every first round touches the two evidence files, m0 and m1.
      const files: number[] = round === 0 ? [0, 1] : [];
      while (files.length < filesPerRound) files.push(next++);
      commits.push({
        mark,
        ref: `refs/heads/${level}`,
        parents: [parent],
        message: `${level}: reviewed round ${round + 1}`,
        changes: files.map((index) => ({
          path: modulePath(index),
          content: roundContent(index),
        })),
      });
      parent = mark;
      mark += 1;
    }
    commits.push({
      mark,
      ref: `refs/heads/${level}`,
      parents: [parent],
      message: `${level}: delta`,
      changes: [delta()],
    });
    branches[level] = { head: mark, frontier: parent };
    mark += 1;
  }
  return { commits, branches };
}

function summarize(level: Level, scope: Scope, prep: Preparation) {
  const sum = (pick: (step: Preparation['steps'][number]) => number): number =>
    prep.steps.reduce((total, step) => total + pick(step), 0);
  return {
    history: level,
    scope,
    cumulativePaths: prep.cumulative.length,
    incrementalPaths: prep.incremental.length,
    manifestPaths: prep.manifest.length,
    acquiredBlobs: sum((step) => step.acquired.byType.blob.count),
    acquiredBlobBytes: sum((step) => step.acquired.byType.blob.bytes),
    packBytes: sum((step) => step.packBytesAdded),
    filesParsed: prep.filesReadForIndex,
    bytesParsed: prep.bytesReadForIndex,
    parseMs: prep.parseMs ?? 0,
    patchBytes: prep.patchBytes,
    patchMs: prep.patchMs,
    wallClockMs: prep.wallClockMs,
  };
}

type Row = ReturnType<typeof summarize>;

async function measure(
  lab: Lab,
  server: Server,
  branch: Branch,
  level: Level,
  scope: Scope,
  sizes: ReadonlyMap<string, number>,
): Promise<Row> {
  const commit = (mark: number): string => server.commits.get(mark) as string;
  const frontier = commit(branch.frontier);
  const client = await lab.createClient(
    `history-${level}-${scope}`,
    server.url,
  );
  const prep = await prepare(lab, client, {
    revisions: {
      head: commit(branch.head),
      mergeBase: commit(1),
      baseTip: commit(1),
      frontier,
    },
    findings: [
      { id: 'F1', path: modulePath(0), baseline: frontier },
      { id: 'F2', path: modulePath(1), baseline: frontier },
    ],
    scope,
    sizeOf: (oid) => sizes.get(oid),
    parse: true,
  });
  return summarize(level, scope, prep);
}

const median = (values: readonly number[]): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

export async function historyScenario(
  lab: Lab,
  repeats = 5,
): Promise<ScenarioRecord> {
  const s = new ScenarioBuilder(
    'history-cost',
    [4],
    'Preparation cost with little, much and maximal reviewed history',
  );
  const fixture = historyFixture();
  const server = await lab.createServer('history', fixture.commits);
  const sizes = new Map<string, number>();
  for (const sha of server.commits.values())
    for (const [oid, size] of await lab.advertisedSizes(server, sha))
      sizes.set(oid, size);
  const runs: Row[] = [];
  for (let repeat = 0; repeat < repeats; repeat += 1)
    for (const level of levelNames)
      for (const scope of scopes)
        runs.push(
          await measure(
            lab,
            server,
            fixture.branches[level],
            level,
            scope,
            sizes,
          ),
        );
  // Counts are identical across repeats; times are medians.
  const table = levelNames.flatMap((level) =>
    scopes.map((scope) => {
      const same = runs.filter((r) => r.history === level && r.scope === scope);
      const first = same[0] as Row;
      return {
        ...first,
        parseMs: median(same.map((r) => r.parseMs)),
        patchMs: median(same.map((r) => r.patchMs)),
        wallClockMs: median(same.map((r) => r.wallClockMs)),
      };
    }),
  );
  const row = (level: Level, scope: Scope): Row =>
    table.find((r) => r.history === level && r.scope === scope) as Row;
  s.check(
    'the incremental delta is the same single path at every history level',
    levelNames.every((level) => row(level, 'union').incrementalPaths === 1),
  );
  s.check(
    'under the union manifest, unrelated acquisition and parsing grow with reviewed history',
    row('little', 'union').acquiredBlobs < row('much', 'union').acquiredBlobs &&
      row('much', 'union').acquiredBlobs < row('cap', 'union').acquiredBlobs &&
      row('little', 'union').filesParsed < row('much', 'union').filesParsed &&
      row('much', 'union').filesParsed < row('cap', 'union').filesParsed,
    levelNames.map((level) => row(level, 'union')),
  );
  s.check(
    'the narrowed plan acquires and parses the same files at every history level',
    levelNames.every(
      (level) =>
        row(level, 'narrowed').acquiredBlobs ===
          row('little', 'narrowed').acquiredBlobs &&
        row(level, 'narrowed').filesParsed ===
          row('little', 'narrowed').filesParsed,
    ),
    levelNames.map((level) => row(level, 'narrowed')),
  );
  s.data({ repeats, levels, moduleBytes, table, runs });
  return s.build();
}
