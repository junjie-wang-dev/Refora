import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join } from 'node:path'

const { mockExistsSync, mockReadFileSync, mockWriteFileSync, mockMkdirSync, mockRenameSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn<[string], boolean>(),
  mockReadFileSync: vi.fn<[string, string], string>(),
  mockWriteFileSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockRenameSync: vi.fn()
}))

vi.mock('node:fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  mkdirSync: mockMkdirSync,
  renameSync: mockRenameSync,
  default: {
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    mkdirSync: mockMkdirSync,
    renameSync: mockRenameSync
  }
}))

import {
  readLibraryFolderPath,
  writeLibraryFolderPath
} from '../../src/main/services/prefs'

describe('prefs helpers', () => {
  beforeEach(() => {
    mockExistsSync.mockReset()
    mockReadFileSync.mockReset()
    mockWriteFileSync.mockReset()
    mockMkdirSync.mockReset()
    mockRenameSync.mockReset()
  })

  it('readLibraryFolderPath returns empty string when no prefs file', () => {
    mockExistsSync.mockReturnValue(false)
    expect(readLibraryFolderPath('/ud')).toBe('')
  })

  it('readLibraryFolderPath reads libraryFolderPath from prefs json', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(JSON.stringify({ libraryFolderPath: '/my/lib' }))
    expect(readLibraryFolderPath('/ud')).toBe('/my/lib')
    expect(mockReadFileSync).toHaveBeenCalledWith(join('/ud', 'refora-prefs.json'), 'utf-8')
  })

  it('readLibraryFolderPath returns empty on malformed json', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue('{ not json')
    expect(readLibraryFolderPath('/ud')).toBe('')
  })

  it.each(['null', '[]', '{"libraryFolderPath":42}'])(
    'readLibraryFolderPath returns empty for valid JSON with an invalid shape: %s',
    (content) => {
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue(content)

      expect(readLibraryFolderPath('/ud')).toBe('')
    }
  )

  it('preserves unknown preferences while normalizing known fields', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(JSON.stringify({
      mineruInstallRoot: '/mineru',
      libraryFolderPath: 42
    }))

    writeLibraryFolderPath('/ud', '/my/lib')

    const [, content] = mockWriteFileSync.mock.calls[0]
    expect(JSON.parse(content as string)).toEqual({
      mineruInstallRoot: '/mineru',
      libraryFolderPath: '/my/lib'
    })
  })

  it('writeLibraryFolderPath writes json with the folder', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue('{}')
    writeLibraryFolderPath('/ud', '/my/lib')
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1)
    const [path, content] = mockWriteFileSync.mock.calls[0]
    expect(path).toMatch(new RegExp(`^${join('/ud', 'refora-prefs.json')}\\.tmp-`))
    expect(JSON.parse(content as string).libraryFolderPath).toBe('/my/lib')
    expect(mockRenameSync).toHaveBeenCalledWith(path, join('/ud', 'refora-prefs.json'))
  })

  it('writeLibraryFolderPath creates parent dir when missing', () => {
    mockExistsSync.mockReturnValue(false)
    writeLibraryFolderPath('/ud', '/my/lib')
    expect(mockMkdirSync).toHaveBeenCalled()
  })

  it('writeLibraryFolderPath exposes persistence failures', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue('{}')
    mockRenameSync.mockImplementation(() => {
      throw new Error('disk full')
    })

    expect(() => writeLibraryFolderPath('/ud', '/my/lib')).toThrow('disk full')
  })
})
