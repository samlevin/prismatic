import { describe, expect, test } from 'vitest';
import { attemptId, effectId, reviewKey, roundKey } from './keys.ts';
import { headB, review } from './testing.ts';

describe('keys', () => {
  test('are deterministic and change with every review input', () => {
    const key = reviewKey(review());
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(reviewKey(review())).toBe(key);
    expect(reviewKey(review(headB))).not.toBe(key);
    expect(reviewKey({ ...review(), reviewerVersion: 'spike-2' })).not.toBe(
      key,
    );
  });

  test('cannot collide through a separator inside a part', () => {
    const a = reviewKey({
      ...review(),
      baseRefName: 'main|x',
      configDigest: 'y',
    });
    const b = reviewKey({
      ...review(),
      baseRefName: 'main',
      configDigest: 'x|y',
    });
    expect(a).not.toBe(b);
  });

  test('give automatic attempts one id and each manual attempt its own', () => {
    const key = reviewKey(review());
    const automatic = attemptId(key);
    expect(attemptId(key)).toBe(automatic);
    const command = attemptId(key, { kind: 'command', id: 9 });
    expect(command).not.toBe(automatic);
    expect(attemptId(key, { kind: 'dispatch', id: 9 })).not.toBe(command);
    expect(roundKey(key, command)).not.toBe(roundKey(key, automatic));
  });

  test('derive effect ids from the round, kind and ordinal', () => {
    const round = roundKey(reviewKey(review()), attemptId(reviewKey(review())));
    const ids = new Set([
      effectId(round, 'inline', 0),
      effectId(round, 'inline', 1),
      effectId(round, 'status', 0),
    ]);
    expect(ids.size).toBe(3);
  });
});
