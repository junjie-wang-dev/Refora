import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join } from 'node:path'

const { mockExistsSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn<(path: string) => boolean>()
}))

vi.mock('node:fs', () => ({
  default: { existsSync: mockExistsSync },
  existsSync: mockExistsSync
}))

import {
  DB_FILE_NAME,
  dbPathForLibraryFolder,
  dbExistsInLibraryFolder
} from '../../src/main/services/dbPath'

describe('dbPath helpers', () => {
  beforeEach(() => {
    mockExistsSync.mockReset()
  })

  it('dbPathForLibraryFolder joins folder with constant db filename', () => {
    expect(dbPathForLibraryFolder('/lib')).toBe(join('/lib', DB_FILE_NAME))
    expect(DB_FILE_NAME).toBe('refora.db')
  })

  it('dbExistsInLibraryFolder returns true when db file exists', () => {
    mockExistsSync.mockImplementation((p: string) => p === join('/lib', DB_FILE_NAME))
    expect(dbExistsInLibraryFolder('/lib')).toBe(true)
  })

  it('dbExistsInLibraryFolder returns false when db file missing', () => {
    mockExistsSync.mockReturnValue(false)
    expect(dbExistsInLibraryFolder('/lib')).toBe(false)
  })
})
