import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
    expect(validateNativePath(file, 'file')).toBe(file)
    expect(validateNativePath(file, 'item')).toBe(file)
    expect(validateNativePath(directory, 'item')).toBe(directory)
  })

  it('rejects relative, missing, mismatched, and symbolic-link paths', () => {
    const { directory, link } = createFixture()
    expect(() => validateNativePath('../paper.pdf', 'file')).toThrow('path must be absolute')
    expect(() => validateNativePath(join(directory, 'missing.pdf'), 'file')).toThrow()
    expect(() => validateNativePath(directory, 'file')).toThrow('path must reference a file')
    expect(() => validateNativePath(link, 'file')).toThrow('symbolic links are not allowed')
  })
})
