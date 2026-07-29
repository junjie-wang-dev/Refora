import { build } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import { rm } from 'node:fs/promises'

await build({
  configFile: false,
  logLevel: 'warn',
  plugins: [tailwindcss()],
  build: {
    emptyOutDir: false,
    cssCodeSplit: false,
    lib: {
      entry: new URL('_utilities.entry.js', import.meta.url).pathname,
      formats: ['es'],
      fileName: '_utilities',
    },
    outDir: new URL('.', import.meta.url).pathname,
    rollupOptions: {
      output: {
        assetFileNames: '_utilities.css',
      },
    },
  },
})

await rm(new URL('_utilities.mjs', import.meta.url), { force: true })
