import { defineConfig } from 'vitest/config';

// Unit tests sit beside their source as *.test.ts; tests/ holds the
// cross-cutting suites. Coverage writes a JSON summary that
// tooling/CoverageGate.ts checks after the run, so the thresholds live in one
// place.
export default defineConfig({
  test: {
    include: [
      'src/**/*.test.ts',
      'apps/**/*.test.ts',
      'tooling/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/fixtures/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'apps/**/*.ts', 'tooling/**/*.ts'],
      exclude: ['**/*.test.ts', '**/fixtures/**'],
      reporter: ['text', 'json-summary'],
      reportsDirectory: 'coverage',
    },
  },
});
