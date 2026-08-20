import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    main: {
      plugins: [externalizeDepsPlugin()],
      define: {
        __REFORA_SUPABASE_URL__: JSON.stringify(env.REFORA_SUPABASE_URL ?? ''),
        __REFORA_SUPABASE_PUBLISHABLE_KEY__: JSON.stringify(
          env.REFORA_SUPABASE_PUBLISHABLE_KEY ?? ''
        )
      },
      build: {
        rollupOptions: {
          input: {
            index: resolve('src/main/index.ts'),
            'worker/pdf-worker': resolve('src/main/worker/pdf-worker.ts')
          }
        }
      }
    },
    preload: {
      build: {
        externalizeDeps: true,
        rollupOptions: {
          input: { index: resolve('src/preload/index.ts') }
        }
      }
    },
    renderer: {
      root: 'src/renderer',
      server: {
        fs: {
          allow: [resolve('.'), realpathSync(resolve('node_modules'))]
        }
      },
      resolve: {
        alias: {
          '@renderer': resolve('src/renderer'),
          '@shared': resolve('src/shared')
        }
      },
      build: {
        rollupOptions: {
          input: { index: resolve('src/renderer/index.html') }
        }
      },
      plugins: [tailwindcss(), react()]
    }
  }
})
