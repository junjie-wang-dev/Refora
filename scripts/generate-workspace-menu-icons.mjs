import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { readFile, writeFile } from 'node:fs/promises'
import { ArrowSquareOut, Clipboard, Copy, Download, FilePlus, FileText, FolderOpen, NotePencil, PencilSimple, Sparkle, Sticker, Trash } from '@phosphor-icons/react/ssr'

const icons = {
  addFile: FilePlus,
  paste: Clipboard,
  sticky: Sticker,
  note: NotePencil,
  copy: Copy,
  edit: PencilSimple,
  export: Download,
  delete: Trash,
  remove: Trash,
  ai: Sparkle,
  file: FileText,
  open: ArrowSquareOut,
  reveal: FolderOpen
}
const assets = {}
for (const [name, Icon] of Object.entries(icons)) {
  assets[name] = []
  for (const scaleFactor of [1, 2]) {
    const size = 16 * scaleFactor
    const svg = renderToStaticMarkup(createElement(Icon, { size, weight: 'regular', color: '#000000' }))
    const canvas = createCanvas(size, size)
    canvas.getContext('2d').drawImage(await loadImage(Buffer.from(svg)), 0, 0)
    assets[name].push({ scaleFactor, dataURL: canvas.toDataURL('image/png') })
  }
}
const output = `export default ${JSON.stringify(assets, null, 2)}\n`
const target = new URL('../src/main/assets/workspaceMenuIcons.ts', import.meta.url)
if (process.argv.includes('--check')) {
  if (await readFile(target, 'utf8') !== output) throw new Error('Workspace menu icons differ from their toolbar sources')
} else {
  await writeFile(target, output)
}
