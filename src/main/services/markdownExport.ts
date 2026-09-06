import { extname, isAbsolute, resolve } from 'node:path'
import type { PrintToPDFOptions, SaveDialogOptions, SaveDialogReturnValue } from 'electron'
import { IpcChannel } from '../../shared/ipc-channels'
import type { Result } from '../../shared/ipc-types'

interface MarkdownExportDependencies {
  showSaveDialog: (options: SaveDialogOptions) => Promise<SaveDialogReturnValue>
  printToPDF: (options: PrintToPDFOptions) => Promise<Uint8Array>
  writeFile: (path: string, data: Uint8Array) => Promise<void>
}

export function createMarkdownExportHandlers(deps: MarkdownExportDependencies) {
  let exporting = false
  return {
    [IpcChannel.ExportMarkdownPdf]: async (title: unknown): Promise<Result<boolean>> => {
      if (typeof title !== 'string' || title.length > 10_000) {
        return { ok: false, error: { code: 'invalid_request', message: 'Invalid Markdown title' } }
      }
      if (exporting) {
        return { ok: false, error: { code: 'export_busy', message: 'A PDF export is already in progress' } }
      }
      exporting = true
      try {
        const filename = [...title]
          .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
          .join('').replace(/[/\\:*?"<>|]/g, '-').trim().replace(/^\.+|\.+$/g, '').slice(0, 120)
          || 'Markdown'
        const result = await deps.showSaveDialog({
          title: `${filename}.pdf`,
          message: `${filename}.pdf`,
          defaultPath: `${filename}.pdf`,
          filters: [{ name: 'PDF', extensions: ['pdf'] }],
          properties: ['createDirectory', 'showOverwriteConfirmation']
        })
        if (result.canceled || !result.filePath) return { ok: true, data: false }
        if (!isAbsolute(result.filePath) || extname(result.filePath).toLowerCase() !== '.pdf') {
          return { ok: false, error: { code: 'invalid_path', message: 'PDF export requires an absolute .pdf path' } }
        }
        const path = resolve(result.filePath)
        const pdf = await deps.printToPDF({
          printBackground: true, pageSize: 'A4', preferCSSPageSize: true,
          margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 }
        })
        await deps.writeFile(path, pdf)
        return { ok: true, data: true }
      } catch {
        return { ok: false, error: { code: 'export_failed', message: 'Unable to export Markdown as PDF' } }
      } finally {
        exporting = false
      }
    }
  }
}
