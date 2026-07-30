import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Git fixture repos and real subprocess spawns are slower than unit tests.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
