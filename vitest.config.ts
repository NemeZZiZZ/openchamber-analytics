import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environment: 'node',
    testTimeout: 15000,
    // Service/UI controllers rely on deterministic fake timers in later tasks.
    restoreMocks: true,
  },
});
