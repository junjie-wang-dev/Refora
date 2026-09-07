import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createClipboardFileHandlers, readClipboardFiles } from '../../src/main/services/clipboardFiles'
import { IpcChannel } from '../../src/shared/ipc-channels'

const mocks = vi.hoisted(() => ({ readBuffer: vi.fn(), read: vi.fn() }))
vi.mock('electron', () => ({ clipboard: mocks }))
let directory: string

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'refora-paste-test-')))
  mocks.readBuffer.mockReturnValue(Buffer.alloc(0))
  mocks.read.mockReturnValue('')
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

function files(format: string, paths: string[]) {
  const json = Buffer.from(JSON.stringify(paths))
  mocks.readBuffer.mockReturnValue(execFileSync('/usr/bin/plutil', ['-convert', format, '-o', '-', '--', '-'], { input: json }))
}

describe('clipboard file import', () => {
  it.each(['xml1', 'binary1'])('reads macOS %s file lists and deduplicates paths', async (format) => {
    const first = join(directory, '论文 & notes.pdf')
    const second = join(directory, 'second.md')
    writeFileSync(first, 'pdf')
    writeFileSync(second, 'markdown')
    files(format, [first, second, first])
    expect(await readClipboardFiles()).toEqual([first, second])
  })

  it('reads a file URL without treating plain clipboard text as a path', async () => {
    expect(await readClipboardFiles()).toEqual([])
    const path = join(directory, 'with spaces.pdf')
    writeFileSync(path, 'pdf')
    mocks.read.mockReturnValue(pathToFileURL(path).href)
    expect(await readClipboardFiles()).toEqual([path])
  })

  it('authorizes only a fully validated file list', async () => {
    const path = join(directory, 'valid.pdf')
    writeFileSync(path, 'pdf')
    files('xml1', [path])
    const authorize = vi.fn((value: string) => value)
    const handler = createClipboardFileHandlers(authorize)[IpcChannel.ClipboardReadFiles]
    expect(await handler()).toEqual({ ok: true, data: [path] })
    expect(authorize).toHaveBeenCalledWith(path)
    authorize.mockClear()
    files('xml1', [path, join(directory, 'missing.pdf')])
    expect(await handler()).toMatchObject({ ok: false, error: { message: expect.any(String) } })
    expect(authorize).not.toHaveBeenCalled()
  })

  it('rejects relative paths, directories, and symbolic links', async () => {
    const link = join(directory, 'link.pdf')
    symlinkSync(directory, link)
    for (const path of ['relative.pdf', directory, link]) {
      files('xml1', [path])
      await expect(readClipboardFiles()).rejects.toThrow()
    }
  })

  it('returns a typed failure for malformed pasteboard data', async () => {
    mocks.readBuffer.mockReturnValue(Buffer.from('invalid plist'))
    const handler = createClipboardFileHandlers(vi.fn())[IpcChannel.ClipboardReadFiles]
    expect(await handler()).toMatchObject({ ok: false, error: { message: 'Could not read clipboard files' } })
  })
})
