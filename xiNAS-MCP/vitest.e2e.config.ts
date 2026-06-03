import { defineConfig } from 'vitest/config';

/**
 * Dedicated config for the SLOW end-to-end suite (J3). The default
 * vitest.config.ts EXCLUDES src/__tests__/e2e/** so the blocking `npm test`
 * gate never runs these process-spawning, timing-sensitive tests. This config
 * does the opposite: it includes ONLY the e2e suite (no exclude entry for it).
 * Invoked via `npm run test:e2e`.
 */
export default defineConfig({
  test: {
    include: ['src/__tests__/e2e/**/*.test.ts'],
    environment: 'node',
    // One worker, no parallelism: each test spawns 2 processes that bind fixed
    // UNIX sockets in a shared temp dir; running them concurrently would race.
    fileParallelism: false,
  },
});
