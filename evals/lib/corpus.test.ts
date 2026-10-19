import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { loadHistories, pilotProblems, summarize } from './corpus.ts';
import { parseHistory } from './history.ts';
import { cleanHistory, sampleHistory } from './testing.ts';

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'prismatic-corpus-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

const write = (name: string, value: unknown): void =>
  writeFileSync(
    join(directory, name),
    typeof value === 'string' ? value : JSON.stringify(value),
  );

describe('loadHistories', () => {
  test('loads every JSON file in name order and ignores other files', () => {
    write('sample.json', sampleHistory());
    write('clean.json', cleanHistory());
    write('README.md', '# Not a history');
    expect(loadHistories(directory).map((history) => history.id)).toEqual([
      'clean',
      'sample',
    ]);
  });

  test('names the file that does not parse', () => {
    write('broken.json', '{');
    expect(() => loadHistories(directory)).toThrow(/^broken\.json: /);
  });

  test('names the file that is not a valid history', () => {
    const history = sampleHistory();
    history['language'] = 'rust';
    write('sample.json', history);
    expect(() => loadHistories(directory)).toThrow(
      'sample.json: language: must be one of',
    );
  });

  test('requires the file name to match the id', () => {
    write('other.json', sampleHistory());
    expect(() => loadHistories(directory)).toThrow(
      'other.json: the file must be named sample.json',
    );
  });
});

describe('summarize and pilotProblems', () => {
  test('count histories, defects, languages, scenarios, and pending checks', () => {
    const histories = [
      parseHistory(sampleHistory()),
      parseHistory(cleanHistory('clean-a')),
    ];
    const summary = summarize(histories);
    expect(summary).toMatchObject({
      histories: 2,
      clean: 1,
      defective: 1,
      defects: 3,
      severeDefects: 2,
      multiRound: 1,
      maxRound: 3,
      languages: { typescript: 2 },
      pendingChecks: ['sample', 'clean-a'],
    });
    expect(summary.scenarios['clean-pr']).toBe(1);
    expect(summary.scenarios['late-round-regression']).toBe(0);
  });

  test('report a pilot that is too small or misses scenarios', () => {
    expect(pilotProblems([parseHistory(sampleHistory())])).toEqual([
      'The pilot needs 8 to 12 histories, not 1.',
      'No history covers late-round-regression.',
      'No history covers clean-pr.',
    ]);
    expect(summarize([]).maxRound).toBe(0);
  });
});
