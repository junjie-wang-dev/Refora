import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { validateNativePath } from '../../src/main/sidecar/nativeRpc'

describe('validateNativePath', () => {
  const directories: string[] = []

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  function createFixture(): { directory: string; file: string; link: string } {
    const directory = mkdtempSync(join(tmpdir(), 'refora-native-path-'))
    directories.push(directory)
    const file = join(directory, 'paper.pdf')
    const link = join(directory, 'paper-link.pdf')
    writeFileSync(file, '%PDF-1.7')
    symlinkSync(file, link)
    return { directory, file, link }
  }

  it('accepts existing absolute files and directories for matching operations', () => {
    const { directory, file } = createFixture()
    expect(validateNativePath(file, 'file')).toBe(realpathSync(file))
    expect(validateNativePath(file, 'item')).toBe(realpathSync(file))
    expect(validateNativePath(directory, 'item')).toBe(realpathSync(directory))
  })

  it('rejects relative, missing, mismatched, and symbolic-link paths', () => {
    const { directory, link } = createFixture()
    expect(() => validateNativePath('../paper.pdf', 'file')).toThrow('path must be absolute')
    expect(() => validateNativePath(join(directory, 'missing.pdf'), 'file')).toThrow()
    expect(() => validateNativePath(directory, 'file')).toThrow('path must reference a file')
    expect(() => validateNativePath(link, 'file')).toThrow('symbolic links are not allowed')
  })

  it('allows managed items and external PDF files but rejects other external items', () => {
    const managed = createFixture()
    const external = createFixture()
    const managedNote = join(managed.directory, 'notes.md')
    const externalNote = join(external.directory, 'notes.md')
    writeFileSync(managedNote, '# Notes')
    writeFileSync(externalNote, '# Notes')
    const policy = {
      managedRoots: [managed.directory],
      capability: 'managed-or-pdf' as const
    }

    expect(validateNativePath(managedNote, 'file', policy)).toBe(realpathSync(managedNote))
    expect(validateNativePath(external.file, 'file', policy)).toBe(realpathSync(external.file))
    expect(() => validateNativePath(externalNote, 'file', policy)).toThrow(
      'outside the allowed native capability'
    )
    expect(() => validateNativePath(external.directory, 'item', policy)).toThrow(
      'outside the allowed native capability'
    )
  })

  it('limits trash capability to managed directories and PDF files', () => {
    const managed = createFixture()
    const managedNote = join(managed.directory, 'notes.md')
    const managedDirectory = join(managed.directory, 'workspace-assets')
    writeFileSync(managedNote, '# Notes')
    mkdirSync(managedDirectory)
    const policy = {
      managedRoots: [managed.directory],
      capability: 'managed-directory-or-pdf' as const
    }

    expect(validateNativePath(managedDirectory, 'item', policy)).toBe(
      realpathSync(managedDirectory)
    )
    expect(validateNativePath(managed.file, 'item', policy)).toBe(realpathSync(managed.file))
    expect(() => validateNativePath(managedNote, 'item', policy)).toThrow(
      'outside the allowed native capability'
    )
    expect(() => validateNativePath(managed.directory, 'item', policy)).toThrow(
      'outside the allowed native capability'
    )
  })

  it('limits temporary clipboard files to Refora Markdown staging directories', () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'refora-native-temp-'))
    directories.push(temporaryRoot)
    const clipboardDirectory = join(temporaryRoot, 'refora-clipboard-token')
    const otherDirectory = join(temporaryRoot, 'other-token')
    mkdirSync(clipboardDirectory)
    mkdirSync(otherDirectory)
    const markdown = join(clipboardDirectory, 'report.md')
    const wrongExtension = join(clipboardDirectory, 'report.txt')
    const wrongDirectory = join(otherDirectory, 'report.md')
    writeFileSync(markdown, '# Report')
    writeFileSync(wrongExtension, 'Report')
    writeFileSync(wrongDirectory, '# Report')
    const policy = {
      temporaryRoot,
      capability: 'managed-or-temporary-clipboard' as const
    }

    expect(validateNativePath(markdown, 'file', policy)).toBe(realpathSync(markdown))
    expect(() => validateNativePath(wrongExtension, 'file', policy)).toThrow(
      'outside the allowed native capability'
    )
    expect(() => validateNativePath(wrongDirectory, 'file', policy)).toThrow(
      'outside the allowed native capability'
    )
  })
})
