import { describe, expect, it } from 'vitest'
import {
  normalizeBootstrapData,
  normalizeListColumnState,
  normalizeWindowBounds
} from '../../src/shared/bootstrap'

const columns = [
  { id: 'title', visible: true, width: 300, order: 0 },
  { id: 'authors', visible: true, width: 192, order: 1 },
  { id: 'year', visible: true, width: 64, order: 2 },
  { id: 'venue', visible: true, width: 128, order: 3 },
  { id: 'addedAt', visible: true, width: 96, order: 4 },
  { id: 'filePath', visible: true, width: 192, order: 5 }
]

describe('bootstrap normalization', () => {
  it('accepts valid persisted window and list state', () => {
    expect(normalizeWindowBounds({
      x: -120,
      y: 40,
      width: 1280,
      height: 800,
      isMaximized: true
    })).toEqual({ x: -120, y: 40, width: 1280, height: 800, isMaximized: true })
    expect(normalizeListColumnState({ columns, sort: { field: 'title', dir: 'asc' } })).toEqual({
      columns,
      sort: { field: 'title', dir: 'asc' }
    })
  })

  it('rejects malformed or unsafe persisted UI state', () => {
    expect(normalizeWindowBounds({ x: 0, y: 0, width: 'wide', height: 800 })).toBeNull()
    expect(normalizeWindowBounds({ x: 0, y: 0, width: 400, height: 800 })).toBeNull()
    expect(normalizeListColumnState({ columns: columns.slice(1), sort: { field: 'title', dir: 'asc' } })).toBeNull()
    expect(normalizeListColumnState({ columns, sort: { field: 'unknown', dir: 'asc' } })).toBeNull()
  })

  it('falls back safely when bootstrap data is malformed', () => {
    expect(normalizeBootstrapData({
      language: 'fr',
      theme: 'neon',
      windowBounds: { width: -1 },
      listColumnState: {},
      sidebarCollapsed: '1',
      firstRun: 'yes',
      libraryFolderPath: 42
    })).toEqual({
      language: 'en',
      theme: 'system',
      windowBounds: null,
      listColumnState: null,
      sidebarCollapsed: false,
      firstRun: false,
      libraryFolderPath: null
    })
  })
})
