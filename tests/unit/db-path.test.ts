import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join } from 'node:path'

const { mockExistsSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn<[string], boolean>()
}))

vi.mock('node:fs', () => ({
  default: { existsSync: mockExistsSync },
  existsSync: mockExistsSync
}))

import {
  DB_FILE_NAME,
  dbPathForLibraryFolder,
  dbExistsInLibraryFolder,
  dbRelatedFiles
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

  it('dbRelatedFiles includes db, wal, shm when they exist', () => {
    const db = join('/lib', DB_FILE_NAME)
    mockExistsSync.mockImplementation((p: string) =>
      p === db || p === db + '-wal' || p === db + '-shm'
    )
    expect(dbRelatedFiles(db)).toEqual([db, db + '-wal', db + '-shm'])
  })

  it('dbRelatedFiles filters out missing sidecar files', () => {
    const db = join('/lib', DB_FILE_NAME)
    mockExistsSync.mockImplementation((p: string) => p === db || p === db + '-wal')
    expect(dbRelatedFiles(db)).toEqual([db, db + '-wal'])
  })
})
