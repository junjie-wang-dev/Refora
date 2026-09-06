import { copyFile, lstat } from 'node:fs/promises'
import { lstatSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { app, clipboard, dialog, nativeImage, shell, type BrowserWindow } from 'electron'
import type { ChatMediaResource } from '../../shared/ipc-types'
import { canOpenChatMedia } from '../../shared/chatMedia'
import { resolveExistingPath } from './existingPath'
import { writeFileToClipboard } from './clipboard'

interface ChatMediaActionDeps {
  getFile: (id: string) => Promise<ChatMediaResource & { path: string }>
  managedRoots: readonly string[]
  getWin: () => BrowserWindow | null
}

export function createChatMediaActions(deps: ChatMediaActionDeps) {
  async function file(id: string): Promise<ChatMediaResource & { path: string }> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid media reference')
    const resource = await deps.getFile(id)
    if (resource.id !== id) throw new Error('Media reference does not match the requested file')
    const path = resolveExistingPath(resource.path, 'file')
    const allowed = deps.managedRoots.some((root) => {
      if (!root) return false
      try {
        const managedRoot = resolveExistingPath(root, 'directory')
        for (const suffix of [['.refora-agent'], ['.refora-agent', 'media'], ['.refora-agent', 'media', id]]) {
          const info = lstatSync(join(managedRoot, ...suffix))
          if (info.isSymbolicLink() || !info.isDirectory()) return false
        }
        const directory = resolveExistingPath(join(managedRoot, '.refora-agent', 'media', id), 'directory')
        const within = relative(directory, path)
        return within !== '' && within === basename(path) && dirname(path) === directory
      } catch {
        return false
      }
    })
    if (!allowed) throw new Error('Media file is outside the managed cache')
    if (resource.byteLength > 100 * 1024 * 1024 || (await lstat(path)).size !== resource.byteLength) {
      throw new Error('Media file size has changed')
    }
    return { ...resource, path }
  }

  return {
    open: async (id: string): Promise<void> => {
      const resource = await file(id)
      if (!canOpenChatMedia(resource.mimeType)) throw new Error('This file can be previewed or saved, but cannot be launched from the conversation')
      const failure = await shell.openPath(resource.path)
      if (failure) throw new Error(failure)
    },
    reveal: async (id: string): Promise<void> => {
      shell.showItemInFolder((await file(id)).path)
    },
    save: async (id: string): Promise<boolean> => {
      const resource = await file(id)
      const options = { defaultPath: join(app.getPath('downloads'), basename(resource.fileName)) }
      const win = deps.getWin()
      const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return false
      const existing = await lstat(result.filePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('Save destination must be a regular file')
      const current = await file(id)
      if (result.filePath !== current.path) await copyFile(current.path, result.filePath)
      return true
    },
    copy: async (id: string): Promise<void> => {
      const resource = await file(id)
      if (resource.kind === 'image') {
        const image = nativeImage.createFromPath(resource.path)
        if (image.isEmpty()) throw new Error('Image could not be copied')
        clipboard.writeImage(image)
      } else {
        writeFileToClipboard(resource.path)
      }
    }
  }
}
