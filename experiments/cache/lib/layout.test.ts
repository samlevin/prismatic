import { describe, expect, test, vi } from 'vitest';
import type {
  CachingOptions,
  PromptMaterial,
  RenderedBlock,
} from './layout.ts';
import {
  planBreakpoints,
  renderBlocks,
  renderRepresentation,
} from './layout.ts';
import { syntheticFile, syntheticSource } from './synthetic.ts';

const a = syntheticSource('src/a.ts', 1, 3);
const b = syntheticSource('src/b.ts', 2, 3);

function material(overrides: Partial<PromptMaterial> = {}): PromptMaterial {
  return {
    nonce: 'run-1',
    instructions: 'Review the change.\n',
    globalRules: [
      syntheticFile('rules/z.md', 'Z rule.\n'),
      syntheticFile('rules/a.md', 'A rule.\n'),
    ],
    context: [{ file: b, level: 'L0' }],
    scope: [
      { file: b, level: 'L0' },
      { file: a, level: 'L0' },
    ],
    suffix: {
      provenance: {
        baseRef: 'base',
        mergeBase: 'mb',
        head: 'head',
        frontier: null,
      },
      diff: '+x',
      mode: 'full',
      attempt: 1,
    },
    ...overrides,
  };
}

const text = (blocks: readonly RenderedBlock[], n: number): string =>
  blocks.find((block) => block.block === n)?.text ?? '';

describe('renderBlocks', () => {
  test('renders five blocks in a stable, path-sorted order', () => {
    const blocks = renderBlocks(material());
    expect(blocks.map((block) => block.block)).toEqual([1, 2, 3, 4, 5]);
    expect(renderBlocks(material())).toEqual(blocks);
    expect(text(blocks, 1).startsWith('run run-1\n')).toBe(true);
    expect(text(blocks, 2).indexOf('rules/a.md')).toBeLessThan(
      text(blocks, 2).indexOf('rules/z.md'),
    );
    expect(text(blocks, 4).indexOf('src/a.ts')).toBeLessThan(
      text(blocks, 4).indexOf('src/b.ts'),
    );
    expect(text(blocks, 4)).toContain(`blob="${a.blobId}"`);
    expect(text(blocks, 4)).toContain('1| // src/a.ts');
  });

  test('keeps provenance and attempt metadata out of the prefix', () => {
    const base = renderBlocks(material());
    const moved = renderBlocks(
      material({
        suffix: {
          provenance: {
            baseRef: 'base-2',
            mergeBase: 'mb',
            head: 'head',
            frontier: 'f',
          },
          diff: '+x',
          mode: 'incremental',
          attempt: 2,
        },
      }),
    );
    for (const n of [1, 2, 3, 4]) expect(text(moved, n)).toBe(text(base, n));
    expect(text(moved, 5)).not.toBe(text(base, 5));
    expect(text(moved, 5)).toContain('frontier: f');
    expect(text(base, 5)).toContain('frontier: none');
  });

  test('a changed block 4 file leaves blocks 1-3 byte-equal', () => {
    const base = renderBlocks(material());
    const edited = renderBlocks(
      material({
        scope: [
          { file: syntheticSource('src/a.ts', 99, 3), level: 'L0' },
          { file: b, level: 'L0' },
        ],
      }),
    );
    for (const n of [1, 2, 3]) expect(text(edited, n)).toBe(text(base, n));
    expect(text(edited, 4)).not.toBe(text(base, 4));
  });
});

describe('renderRepresentation', () => {
  test('L2 keeps signatures with original line numbers and omits bodies', () => {
    const rendered = renderRepresentation({ file: a, level: 'L2' });
    expect(rendered).toContain('level="L2"');
    expect(rendered.match(/body omitted/g)).toHaveLength(3);
    expect(rendered).toMatch(/^3\| export function /m);
    expect(rendered).not.toContain('const scaled');
  });

  test('L3 lists exported names only', () => {
    const rendered = renderRepresentation({ file: a, level: 'L3' });
    expect(rendered).toMatch(/^exports: \w+0, \w+1, \w+2$/m);
  });

  test('L0 numbers a file without a trailing newline too', () => {
    const rendered = renderRepresentation({
      file: syntheticFile('x.ts', 'one\ntwo'),
      level: 'L0',
    });
    expect(rendered).toContain('1| one\n2| two\n</file>');
  });
});

describe('planBreakpoints', () => {
  const blocks = renderBlocks(material());
  const all: CachingOptions = {
    enabled: true,
    contextBreakpoints: true,
    changedFileBreakpoint: true,
    minimumPrefixTokens: 1024,
  };
  const position = (k: number): number => k * 2000;

  test('places up to four breakpoints at the measured positions', () => {
    expect(planBreakpoints(blocks, position, all)).toEqual({
      breakpoints: [1, 2, 3, 4].map((k) => ({
        afterBlock: k,
        prefixTokens: k * 2000,
      })),
      skipped: [],
    });
  });

  test('writes none when caching is disabled, without counting', () => {
    const counter = vi.fn(position);
    const plan = planBreakpoints(blocks, counter, { ...all, enabled: false });
    expect(plan.breakpoints).toEqual([]);
    expect(plan.skipped.map((s) => s.reason)).toEqual(
      Array(4).fill('caching-disabled'),
    );
    expect(counter).not.toHaveBeenCalled();
  });

  test('leaves BP3 and BP4 out unless their options are on', () => {
    const plan = planBreakpoints(blocks, position, {
      ...all,
      contextBreakpoints: false,
      changedFileBreakpoint: false,
    });
    expect(plan.breakpoints.map((p) => p.afterBlock)).toEqual([1, 2]);
    expect(plan.skipped).toEqual([
      { afterBlock: 3, reason: 'boundary-disabled' },
      { afterBlock: 4, reason: 'boundary-disabled' },
    ]);
  });

  test('coalesces an empty block and never pads a short prefix', () => {
    const sparse = renderBlocks(material({ globalRules: [], context: [] }));
    const plan = planBreakpoints(sparse, (k) => k * 400, all);
    expect(plan.breakpoints).toEqual([{ afterBlock: 4, prefixTokens: 1600 }]);
    expect(plan.skipped).toEqual([
      { afterBlock: 1, reason: 'below-minimum' },
      { afterBlock: 2, reason: 'coincident' },
      { afterBlock: 3, reason: 'coincident' },
    ]);
  });
});
