import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // The e2e suite spawns 2 real processes and is timing-sensitive; it is
    // SLOW and excluded from the blocking `npm test` gate. Run it explicitly
    // with `npm run test:e2e`.
    exclude: [...configDefaults.exclude, 'src/__tests__/e2e/**'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/__tests__/**'],
    },
  },
});
