import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const read = (file: string) =>
  readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

interface Manifest {
  readonly engines: Readonly<Record<string, string>>;
  readonly scripts: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

const manifest = JSON.parse(read('package.json')) as Manifest;

test('the root package runs lint, typecheck, test, and build', () => {
  expect(manifest.scripts).toMatchObject({
    lint: 'eslint . --max-warnings 0',
    typecheck: 'tsc -p tsconfig.json',
    test: 'npm run test:scripts && npm run test:unit',
    'test:unit':
      'vitest run --coverage && node tooling/CoverageGate.ts coverage/coverage-summary.json',
    build: 'tsc -p tsconfig.build.json',
  });
});

test('Node 24 is pinned and required', () => {
  expect(read('.tool-versions')).toMatch(/^nodejs 24\.\d+\.\d+$/m);
  expect(manifest.engines['node']).toBe('>=24');
  expect(read('.npmrc')).toMatch(/^engine-strict=true$/m);
});

test('no LangGraph dependency is installed (ADR 0006)', () => {
  const names = Object.keys({
    ...manifest.dependencies,
    ...manifest.devDependencies,
  });
  expect(names.filter((name) => /langgraph|langchain/i.test(name))).toEqual([]);
});

test('TypeScript keeps the strict options the modules compile under', () => {
  const { compilerOptions } = JSON.parse(read('tsconfig.json')) as {
    compilerOptions: Record<string, unknown>;
  };
  expect(compilerOptions).toMatchObject({
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
  });
});
