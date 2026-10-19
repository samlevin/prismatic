// Loads a directory of labeled histories and summarizes what it covers.
// Every `*.json` file in the directory is one history named `<id>.json`.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseHistory,
  scenarios,
  type LabeledHistory,
  type Scenario,
} from './history.ts';

// The scenarios P0.11a (#144) requires the pilot to cover.
export const pilotScenarios: readonly Scenario[] = [
  'correct-high-severity',
  'false-positive',
  'incremental-fix',
  'dismissed-finding',
  'unreviewable-change',
  'late-round-regression',
  'clean-pr',
];

export const pilotSize = { min: 8, max: 12 } as const;

export function loadHistories(directory: string): LabeledHistory[] {
  const files = readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort();
  return files.map((name) => {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(directory, name), 'utf8'));
    } catch (error) {
      throw new Error(`${name}: ${(error as Error).message}`, { cause: error });
    }
    let history: LabeledHistory;
    try {
      history = parseHistory(raw);
    } catch (error) {
      throw new Error(`${name}: ${(error as Error).message}`, { cause: error });
    }
    if (`${history.id}.json` !== name) {
      throw new Error(`${name}: the file must be named ${history.id}.json`);
    }
    return history;
  });
}

export interface CorpusSummary {
  readonly histories: number;
  readonly clean: number;
  readonly defective: number;
  readonly defects: number;
  readonly severeDefects: number;
  readonly multiRound: number;
  readonly maxRound: number;
  readonly languages: Readonly<Record<string, number>>;
  readonly scenarios: Readonly<Record<Scenario, number>>;
  // Histories whose labels still wait for the second person's check.
  readonly pendingChecks: readonly string[];
}

export function summarize(histories: readonly LabeledHistory[]): CorpusSummary {
  const languages: Record<string, number> = {};
  const covered = Object.fromEntries(
    scenarios.map((name) => [name, 0]),
  ) as Record<Scenario, number>;
  let defects = 0;
  let severeDefects = 0;
  for (const history of histories) {
    languages[history.language] = (languages[history.language] ?? 0) + 1;
    for (const scenario of history.scenarios) covered[scenario] += 1;
    defects += history.labels.defects.length;
    severeDefects += history.labels.defects.filter(
      (defect) => defect.severity === 'high' || defect.severity === 'critical',
    ).length;
  }
  const clean = histories.filter(
    (history) => history.labels.defects.length === 0,
  ).length;
  return {
    histories: histories.length,
    clean,
    defective: histories.length - clean,
    defects,
    severeDefects,
    multiRound: histories.filter((history) => history.source.rounds.length > 1)
      .length,
    maxRound: Math.max(
      0,
      ...histories.map((history) => history.source.rounds.length),
    ),
    languages,
    scenarios: covered,
    pendingChecks: histories
      .filter((history) => history.labels.check.status === 'pending')
      .map((history) => history.id),
  };
}

// Problems that keep a set of histories from serving as the pilot corpus.
export function pilotProblems(histories: readonly LabeledHistory[]): string[] {
  const summary = summarize(histories);
  const problems: string[] = [];
  if (summary.histories < pilotSize.min || summary.histories > pilotSize.max) {
    problems.push(
      `The pilot needs ${pilotSize.min} to ${pilotSize.max} histories, not ${summary.histories}.`,
    );
  }
  for (const scenario of pilotScenarios) {
    if (summary.scenarios[scenario] === 0)
      problems.push(`No history covers ${scenario}.`);
  }
  return problems;
}
