import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  createCanvas,
  DOMMatrix as CanvasDOMMatrix,
  Path2D as CanvasPath2D,
  type Canvas,
  type SKRSContext2D
} from '@napi-rs/canvas'

const parentPort = process.parentPort
const pdfGlobals = globalThis as typeof globalThis & {
  DOMMatrix?: typeof CanvasDOMMatrix
  Path2D?: typeof CanvasPath2D
}
pdfGlobals.DOMMatrix ??= CanvasDOMMatrix
pdfGlobals.Path2D ??= CanvasPath2D

type PdfBinaryDataKind = 'cMapUrl' | 'standardFontDataUrl' | 'wasmUrl'

class FileBinaryDataFactory {
  private readonly roots: Record<PdfBinaryDataKind, string | null>

  constructor(options: Partial<Record<PdfBinaryDataKind, string | null>>) {
    this.roots = {
      cMapUrl: options.cMapUrl ?? null,
      standardFontDataUrl: options.standardFontDataUrl ?? null,
      wasmUrl: options.wasmUrl ?? null
    }
  }

  async fetch(input: { kind: PdfBinaryDataKind; filename: string }): Promise<Uint8Array> {
    const root = this.roots[input.kind]
    if (!root) throw new Error(`Missing PDF binary data root for ${input.kind}`)
    return new Uint8Array(readFileSync(join(root, input.filename)))
  }
}

interface NapiCanvasAndContext {
  canvas: Canvas | null
  context: SKRSContext2D | null
}

class NapiCanvasFactory {
  create(width: number, height: number): NapiCanvasAndContext {
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size')
    const canvas = createCanvas(width, height)
    return { canvas, context: canvas.getContext('2d') }
  }

  reset(canvasAndContext: NapiCanvasAndContext, width: number, height: number): void {
    if (!canvasAndContext.canvas) throw new Error('Canvas is not specified')
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size')
    canvasAndContext.canvas.width = width
    canvasAndContext.canvas.height = height
  }

  destroy(canvasAndContext: NapiCanvasAndContext): void {
    if (!canvasAndContext.canvas) throw new Error('Canvas is not specified')
    canvasAndContext.canvas.width = 0
    canvasAndContext.canvas.height = 0
    canvasAndContext.canvas = null
    canvasAndContext.context = null
  }
}

interface WorkerRequest {
  correlationId: string
  filePath: string
  action: 'preview'
}

interface WorkerResponse {
  correlationId: string
  error?: { type: 'encrypted' | 'corrupted' | 'other'; message: string }
  preview?: Uint8Array
}

export async function renderPdfPreview(
  filePath: string,
  maxWidth = 480,
  maxHeight = 640
): Promise<Uint8Array> {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs')
  pdfjsLib.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')
  const pdfRoot = dirname(dirname(dirname(require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'))))
  const data = new Uint8Array(readFileSync(filePath))
  const loadingTask = pdfjsLib.getDocument({
    data,
    CanvasFactory: NapiCanvasFactory,
    BinaryDataFactory: FileBinaryDataFactory,
    useWorkerFetch: false,
    useSystemFonts: false,
    disableFontFace: true,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    useWasm: false,
    disableAutoFetch: true,
    standardFontDataUrl: join(pdfRoot, 'standard_fonts') + '/',
    cMapUrl: join(pdfRoot, 'cmaps') + '/',
    cMapPacked: true
  })
  let cleanupPage: { cleanup: () => boolean } | null = null
  let cleanupCanvas: Canvas | null = null
  try {
    const pdfDoc = await loadingTask.promise
    const page = await pdfDoc.getPage(1)
    cleanupPage = page
    const baseViewport = page.getViewport({ scale: 1 })
    const scale = Math.min(maxWidth / baseViewport.width, maxHeight / baseViewport.height)
    const viewport = page.getViewport({ scale })
    const canvas = createCanvas(
      Math.max(1, Math.round(viewport.width)),
      Math.max(1, Math.round(viewport.height))
    )
    cleanupCanvas = canvas
    const context = canvas.getContext('2d')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({
      canvas: canvas as never,
      canvasContext: context as never,
      viewport
    }).promise
    return new Uint8Array(canvas.toBuffer('image/png'))
  } finally {
    try {
      cleanupPage?.cleanup()
    } catch {
      void 0
    }
    if (cleanupCanvas) {
      cleanupCanvas.width = 0
      cleanupCanvas.height = 0
    }
    await loadingTask.destroy().catch(() => {})
  }
}

function isPdf(path: string): boolean {
  try {
    const stats = statSync(path)
    return stats.isFile() && path.toLowerCase().endsWith('.pdf')
  } catch {
    return false
  }
}

if (parentPort) {
  parentPort.on('message', async (event: { data: WorkerRequest }) => {
    const { correlationId, filePath } = event.data
    if (!isPdf(filePath)) {
      parentPort.postMessage({
        correlationId,
        error: { type: 'other', message: `Not a PDF file: ${filePath}` }
      } satisfies WorkerResponse)
      return
    }
    try {
      const preview = await renderPdfPreview(filePath)
      parentPort.postMessage({ correlationId, preview } satisfies WorkerResponse)
    } catch (error) {
      const name = (error as { name?: string }).name ?? ''
      const message = error instanceof Error ? error.message : String(error)
      const type =
        name === 'PasswordException' || message.toLowerCase().includes('password')
          ? 'encrypted'
          : name === 'InvalidPDFException' || name === 'UnknownErrorException'
            ? 'corrupted'
            : 'other'
      parentPort.postMessage({
        correlationId,
        error: { type, message }
      } satisfies WorkerResponse)
    }
  })
}
