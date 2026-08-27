import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join } from 'node:path'

const { mockExistsSync, mockReaddirSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn<(path: string) => boolean>(),
  mockReaddirSync: vi.fn(() => [])
}))

vi.mock('node:fs', () => ({
  default: { existsSync: mockExistsSync, readdirSync: mockReaddirSync },
  existsSync: mockExistsSync,
  readdirSync: mockReaddirSync
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

  it('places the working database in device-local application storage', () => {
    expect(dbPathForLibraryFolder('/user-data', '')).toBe(join('/user-data', DB_FILE_NAME))
    expect(dbPathForLibraryFolder('/user-data', '/lib')).toMatch(
      /^\/user-data\/libraries\/[0-9a-f]{32}\/working\.db$/
    )
    expect(DB_FILE_NAME).toBe('working.db')
  })

  it('dbExistsInLibraryFolder returns true when db file exists', () => {
    const working = dbPathForLibraryFolder('/user-data', '/lib')
    mockExistsSync.mockImplementation((p: string) => p === working)
    expect(dbExistsInLibraryFolder('/user-data', '/lib')).toBe(true)
  })

  it('dbExistsInLibraryFolder returns false when db file missing', () => {
    mockExistsSync.mockReturnValue(false)
    expect(dbExistsInLibraryFolder('/user-data', '/lib')).toBe(false)
  })
})
