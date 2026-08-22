import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { loadEnv } from 'vite'

function rendererChunk(id: string): string | undefined {
  const normalized = id.replaceAll('\\', '/')
  if (!normalized.includes('/node_modules/')) return undefined
  if (/\/node_modules\/(react|react-dom|scheduler|zustand|use-sync-external-store|i18next|react-i18next)\//.test(normalized)) {
    return 'vendor-react'
  }
  if (normalized.includes('/node_modules/pdfjs-dist/')) return 'vendor-pdf'
  if (/\/node_modules\/(react-markdown|remark-|rehype-|unified|katex|micromark|mdast-|hast-|hastscript|unist-|vfile)/.test(normalized)) {
    return 'vendor-markdown'
  }
  if (/\/node_modules\/(antd|@ant-design|@rc-component|rc-|@lobehub|antd-style|@emotion|motion|framer-motion)/.test(normalized)) {
    return 'vendor-ui'
  }
  if (/\/node_modules\/(@phosphor-icons|lucide-react)\//.test(normalized)) return 'vendor-icons'
  return 'vendor'
}

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
          input: { index: resolve('src/renderer/index.html') },
          output: {
            manualChunks: rendererChunk
          }
        }
      },
      plugins: [tailwindcss(), react()]
    }
  }
})
