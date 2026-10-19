import { describe, expect, test } from 'vitest';
import type { RenderedBlock } from './layout.ts';
import { renderBlocks } from './layout.ts';
import type { VariantSpec } from './scenarios.ts';
import { materialFor, minimumPrefixTokens, scenarios } from './scenarios.ts';
import { tokenizerCandidates } from './tokens.ts';

const render = (variant: VariantSpec, nonce = 'n'): RenderedBlock[] =>
  renderBlocks(materialFor(nonce, variant));

// Block numbers whose text differs from the unchanged material.
function changedBlocks(variant: VariantSpec): number[] {
  const base = render({});
  const changed = render(variant);
  return base
    .filter((block, i) => block.text !== changed[i]?.text)
    .map((block) => block.block);
}

describe('scenarios', () => {
  test('ids are unique and every acceptance criterion is exercised', () => {
    const ids = scenarios.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const criteria = new Set(scenarios.flatMap((s) => s.criteria));
    expect([...criteria].sort()).toEqual([1, 2, 3, 4]);
  });

  test('a comparison always names an earlier step of the same scenario', () => {
    for (const scenario of scenarios) {
      scenario.steps.forEach((step, i) => {
        if (step.compareWith === undefined) return;
        const earlier = scenario.steps.slice(0, i).map((s) => s.label);
        expect(earlier).toContain(step.compareWith);
      });
    }
  });

  test('covers the matrix #142 asks for', () => {
    const ids = scenarios.map((s) => s.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'cold-warm',
        'block4-early-change',
        'block4-late-change',
        'scope-change',
        'representation-change',
        'base-provenance-only',
        'caching-disabled',
        'short-stable-prefix',
        'effort-high-to-medium',
        'effort-configuration-update',
        'schema-variants',
      ]),
    );
    const update = scenarios.find(
      (s) => s.id === 'effort-configuration-update',
    );
    expect(update?.steps.map((s) => s.reasoning)).toEqual([
      { requestEffort: 'high' },
      { requestEffort: 'high', updateEffort: 'medium' },
      { requestEffort: 'high', updateEffort: 'medium' },
    ]);
  });
});

describe('materialFor', () => {
  test('renders equal bytes for equal nonces and variants', () => {
    expect(render({})).toEqual(render({}));
    expect(render({}, 'other')[0]?.text).not.toBe(render({})[0]?.text);
    expect(render({}, 'other').slice(1)).toEqual(render({}).slice(1));
  });

  test('each variant changes only the blocks it targets', () => {
    expect(changedBlocks({ editScope: 'first' })).toEqual([4]);
    expect(changedBlocks({ editScope: 'last' })).toEqual([4]);
    expect(changedBlocks({ widenScope: true })).toEqual([3, 4, 5]);
    expect(changedBlocks({ contextLevel: 'L2' })).toEqual([3]);
    expect(changedBlocks({ rebased: true })).toEqual([5]);
  });

  test('early and late edits land in different block 4 files', () => {
    const base = render({})[3]?.text ?? '';
    const early = render({ editScope: 'first' })[3]?.text ?? '';
    const late = render({ editScope: 'last' })[3]?.text ?? '';
    const firstDiff = (a: string, b: string): number =>
      [...a].findIndex((ch, i) => ch !== b[i]);
    expect(firstDiff(base, early)).toBeLessThan(base.length / 4);
    expect(firstDiff(base, late)).toBeGreaterThan((base.length * 3) / 4);
  });

  test('the short variant keeps its prefix under the minimum in a longer request', () => {
    const [o200k] = tokenizerCandidates;
    const blocks = render({ short: true });
    const count = (bs: RenderedBlock[]): number =>
      bs.reduce((sum, b) => sum + (o200k?.count(b.text) ?? 0), 0);
    expect(count(blocks.slice(0, 4))).toBeLessThan(minimumPrefixTokens);
    expect(count(blocks)).toBeGreaterThan(2 * minimumPrefixTokens);
    expect(count(render({}).slice(0, 1))).toBeGreaterThan(minimumPrefixTokens);
  });
});
