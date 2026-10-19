import { describe, expect, it } from 'vitest';
import { canonicalJson } from './canonical.ts';

describe('canonicalJson', () => {
  it('gives the same bytes whatever the key insertion order', () => {
    const first = { b: 1, a: { d: [3, { y: true, x: null }], c: 'text' } };
    const second = { a: { c: 'text', d: [3, { x: null, y: true }] }, b: 1 };
    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(canonicalJson(first)).toBe(
      '{"a":{"c":"text","d":[3,{"x":null,"y":true}]},"b":1}',
    );
  });

  it('sorts keys by UTF-16 code unit, not by locale', () => {
    const value = { b: 0, B: 0, a: 0, _: 0, '10': 0, '9': 0, é: 0 };
    expect(canonicalJson(value)).toBe(
      '{"10":0,"9":0,"B":0,"_":0,"a":0,"b":0,"é":0}',
    );
  });

  it('keeps array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('serializes primitives the way JSON does', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(false)).toBe('false');
    expect(canonicalJson(-0)).toBe('0');
    expect(canonicalJson(1e21)).toBe('1e+21');
    expect(canonicalJson(0.1 + 0.2)).toBe('0.30000000000000004');
    expect(canonicalJson('quote " and \\ and \n')).toBe(
      '"quote \\" and \\\\ and \\n"',
    );
    expect(canonicalJson('\uD800')).toBe('"\\ud800"');
  });

  it('omits object properties whose value is undefined', () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it('accepts objects without a prototype and shared references', () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare['k'] = 'v';
    const shared = { n: 1 };
    expect(canonicalJson({ bare, left: shared, right: shared })).toBe(
      '{"bare":{"k":"v"},"left":{"n":1},"right":{"n":1}}',
    );
  });

  it('ignores symbol keys, as JSON does', () => {
    expect(canonicalJson({ [Symbol('s')]: 1, a: 2 })).toBe('{"a":2}');
  });

  it.each([
    ['undefined', undefined],
    ['undefined in an array', [undefined]],
    // eslint-disable-next-line no-sparse-arrays -- the hole is the case
    ['an array hole', [1, , 3]],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a bigint', 1n],
    ['a symbol', Symbol('s')],
    ['a function', () => 1],
    ['a Date', new Date(0)],
    ['a Map', new Map()],
    ['a class instance', new (class Point {})()],
    ['a nested non-finite number', { a: [Number.NEGATIVE_INFINITY] }],
  ])('refuses %s', (_label, value) => {
    expect(() => canonicalJson(value)).toThrow(TypeError);
  });

  it('refuses cycles', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/cyclic/);
    const list: unknown[] = [];
    list.push(list);
    expect(() => canonicalJson(list)).toThrow(/cyclic/);
  });
});
