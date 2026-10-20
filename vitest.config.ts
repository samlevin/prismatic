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
      'experiments/**/*.test.ts',
    ],
    // tests/e2e/ builds and runs the Docker image, so it needs Docker and,
    // for the build, the network. `npm run test:container` runs it.
    exclude: [
      '**/node_modules/**',
      'tooling/eslint/fixtures/**',
      'tests/e2e/**',
    ],
    coverage: {
      provider: 'v8',
      // Experiment libraries are measured too. Each spike driver is left out:
      // experiments/fetch/spike/ drives Git inside the pinned image and
      // experiments/cache/spike/ calls the provider, and their recorded
      // results are their evidence.
      include: [
        'src/**/*.ts',
        'apps/**/*.ts',
        'tooling/**/*.ts',
        'experiments/**/*.ts',
      ],
      exclude: [
        '**/*.test.ts',
        'tooling/eslint/fixtures/**',
        'experiments/fetch/spike/**',
        'experiments/cache/spike/**',
      ],
      reporter: ['text', 'json-summary'],
      reportsDirectory: 'coverage',
    },
  },
});
