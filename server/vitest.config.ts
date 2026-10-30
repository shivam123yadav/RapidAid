import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'forks',
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    // Tests share one MongoDB test database — run files serially to avoid
    // one file's dropDatabase() racing another file's queries.
    fileParallelism: false,
    sequence: { concurrent: false },
    include: ['tests/**/*.test.ts'],
    hookTimeout: 30000,
    testTimeout: 20000,
  },
});
