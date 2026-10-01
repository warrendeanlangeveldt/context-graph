import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Messages name ctx commands as `ctx …` whatever is installed on the machine running the tests.
    env: { CTX_COMMAND: 'ctx' },
  },
});
