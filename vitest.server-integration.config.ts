import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/serverLifecycle.e2e.test.ts'],
    globals: false,
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 10_000
  }
})
