import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer'),
      '@shared': resolve('src/shared')
    }
  },
  test: {
    environment: 'jsdom',
    include: [
      'tests/unit/**/*.test.ts',
      'tests/component/**/*.test.tsx',
      'tests/integration/**/*.test.ts',
      'tests/smoke/**/*.test.ts'
    ],
    exclude: ['tests/integration/serverLifecycle.e2e.test.ts'],
    globals: false,
    setupFiles: ['tests/setup.ts'],
    server: {
      deps: {
        inline: ['@lobehub/ui']
      }
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/renderer/env.d.ts',
        'src/**/*.d.ts'
      ],
      thresholds: {
        lines: 70,
        branches: 55,
        functions: 70,
        statements: 70,
        'src/main/services/webSecurity.ts': {
          lines: 100,
          branches: 85,
          functions: 100,
          statements: 100
        },
        'src/main/services/fileCapabilities.ts': {
          lines: 90,
          branches: 75,
          functions: 90,
          statements: 90
        },
        'src/main/services/safeStorageProxy.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100
        },
        'src/main/sidecar/client.ts': {
          lines: 60,
          branches: 60,
          functions: 38,
          statements: 59
        }
      }
    }
  }
})
