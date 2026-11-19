import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // Tests set OVERLOOK_HOME per file; keep files isolated.
    pool: 'forks',
    fileParallelism: false,
  },
});
