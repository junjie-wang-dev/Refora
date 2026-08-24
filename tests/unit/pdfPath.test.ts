import { beforeEach, describe, expect, it, vi } from 'vitest'

const { lstatSync, realpathSync } = vi.hoisted(() => ({
  lstatSync: vi.fn(),
  realpathSync: vi.fn()
}))

vi.mock('node:fs', () => ({
  default: { lstatSync, realpathSync },
  lstatSync,
  realpathSync
}))

import { resolvePdfFilePath } from '../../src/main/services/pdfPath'

describe('resolvePdfFilePath', () => {
  beforeEach(() => {
    realpathSync.mockReset().mockImplementation((path) => path)
    lstatSync.mockReset().mockReturnValue({
      isSymbolicLink: () => false,
      isFile: () => true,
      isDirectory: () => false
    })
  })

  it('returns a validated absolute PDF path', () => {
    expect(resolvePdfFilePath('/library/paper.pdf')).toBe('/library/paper.pdf')
  })

  it('rejects relative, non-PDF, missing, symbolic-link, and directory paths', () => {
    expect(() => resolvePdfFilePath('../paper.pdf')).toThrow('absolute')
    expect(() => resolvePdfFilePath('/library/paper.txt')).toThrow('PDF')

    lstatSync.mockImplementationOnce(() => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    })
    expect(() => resolvePdfFilePath('/library/missing.pdf')).toThrow('File not found')

    lstatSync.mockReturnValue({
      isSymbolicLink: () => true,
      isFile: () => true,
      isDirectory: () => false
    })
    expect(() => resolvePdfFilePath('/library/link.pdf')).toThrow('regular PDF')

    lstatSync.mockReturnValue({
      isSymbolicLink: () => false,
      isFile: () => false,
      isDirectory: () => true
    })
    expect(() => resolvePdfFilePath('/library/folder.pdf')).toThrow('regular PDF')
  })
})
