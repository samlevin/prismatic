import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// `npm run test:container` runs the container smoke tests with this file.
// They need Docker, and building the image needs the network, so the unit
// run in vitest.config.ts leaves tests/e2e/ out. Set PRISMATIC_SMOKE_IMAGE to
// test an image that is already built instead of building one.
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    // The image build compiles Git, which takes minutes on a cold cache.
    hookTimeout: 30 * 60 * 1000,
    testTimeout: 5 * 60 * 1000,
  },
});
