// Checks the committed pilot corpus in evals/labeled/pilot/ against the
// P0.11a (#144) requirements and the protocol's corpus rules.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { patternSecretRedactor } from '../../src/shared/redaction.ts';
import { loadHistories, pilotProblems, summarize } from './corpus.ts';
import { treeAtRound } from './history.ts';

const directory = fileURLToPath(new URL('../labeled/pilot/', import.meta.url));
const histories = loadHistories(directory);

describe('pilot corpus', () => {
  test('parses and covers every required scenario in 8 to 12 histories', () => {
    expect(pilotProblems(histories)).toEqual([]);
  });

  test('measures the initial language set and includes clean and multi-round histories', () => {
    const summary = summarize(histories);
    expect(Object.keys(summary.languages).sort()).toEqual([
      'go',
      'python',
      'typescript',
    ]);
    expect(summary.clean).toBeGreaterThanOrEqual(2);
    expect(summary.multiRound).toBeGreaterThanOrEqual(4);
    expect(summary.maxRound).toBeGreaterThanOrEqual(6);
  });

  test('is synthetic, licensed, and labeled by one party and checked by another', () => {
    for (const history of histories) {
      expect(history.provenance.origin).toBe('synthetic');
      expect(history.provenance.license).toBe('MIT');
      const { check, labeledBy } = history.labels;
      if (check.status !== 'pending') expect(check.by).not.toBe(labeledBy);
    }
  });

  test('holds no credential-shaped text', () => {
    for (const history of histories) {
      for (let round = 0; round <= history.source.rounds.length; round += 1) {
        for (const [path, lines] of treeAtRound(history, round)) {
          const content = lines.join('\n');
          expect(
            patternSecretRedactor.redactText(content),
            `${history.id} ${path}`,
          ).toBe(content);
        }
      }
      const prose = JSON.stringify([history.pullRequest, history.labels]);
      expect(patternSecretRedactor.redactText(prose)).toBe(prose);
    }
  });

  test('keeps mock responses out of labeled histories', () => {
    for (const name of readdirSync(directory)) {
      if (!name.endsWith('.json')) continue;
      const raw = JSON.parse(readFileSync(`${directory}${name}`, 'utf8')) as {
        [key: string]: unknown;
      };
      expect(Object.keys(raw)).not.toContain('mockResponses');
    }
  });
});
