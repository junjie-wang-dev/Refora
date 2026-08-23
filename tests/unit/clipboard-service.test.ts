import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeFileToClipboard } from '../../src/main/services/clipboard'

const electronMocks = vi.hoisted(() => ({
  writeBuffer: vi.fn(),
}))

vi.mock('electron', () => ({
  clipboard: {
    writeBuffer: electronMocks.writeBuffer,
  }
}))

describe('clipboard service', () => {
  const cleanupPaths: string[] = []

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    for (const path of cleanupPaths.splice(0)) {
      rmSync(path, { recursive: true, force: true })
    }
  })

  it('writes a regular file as a macOS file-list pasteboard value', () => {
    const directory = mkdtempSync(join(tmpdir(), 'refora-clipboard-source-'))
    cleanupPaths.push(directory)
    const filePath = join(directory, 'paper & notes.pdf')
    writeFileSync(filePath, 'pdf')

    writeFileToClipboard(filePath)

    expect(electronMocks.writeBuffer).toHaveBeenCalledOnce()
    const [format, buffer] = electronMocks.writeBuffer.mock.calls[0] as [string, Buffer]
    expect(format).toBe('NSFilenamesPboardType')
    expect(buffer.toString('utf8')).toContain(`${directory}/paper &amp; notes.pdf`)
  })
})
