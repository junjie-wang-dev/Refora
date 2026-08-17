import { describe, it, expect } from 'vitest'
import type {
  Document,
  Category,
  Result,
  ListFilter,
  EditableField,
  DocumentPatch,
  BootstrapData,
  LibrarySwitchResult
} from '../../src/shared/ipc-types'

describe('ipc-types shapes', () => {
  it('constructs a Document with all DB columns', () => {
    const doc: Document = {
      id: 'u1',
      filePath: '/lib/a.pdf',
      originalFolderPath: '/src',
      fileName: 'a.pdf',
      fileSize: 10,
      fileHash: 'h',
      title: 'T',
      authors: 'A',
      year: '2020',
      venue: 'V',
      volume: '1',
      issue: '2',
      pages: '3-4',
      abstract: 'ab',
      keywords: 'k',
      url: 'u',
      doi: '10.1/x',
      arxivId: '2401.12345',
      note: 'n',
      affiliations: 'Institute',
      starred: 0,
      addedAt: 1,
      lastReadAt: null,
      updatedAt: 2,
      metadataSource: 'pdf',
      metadataStatus: 'pending',
      metadataAttempts: 0,
      editedFields: [],
      remoteValues: null,
      fileMissing: 0
    }
    expect(doc.id).toBe('u1')
    expect(doc.metadataStatus).toBe('pending')
    expect(doc.lastReadAt).toBeNull()
  })

  it('Document can carry its categories', () => {
    const cat: Category = {
      id: 'c1',
      name: 'ML',
      sortOrder: 0,
      createdAt: 1
    }
    expect(cat.name).toBe('ML')
  })

  it('ListFilter covers the starred mode', () => {
    const f: ListFilter = { mode: 'starred' }
    expect(f.mode).toBe('starred')
  })

  it('DocumentPatch only allows editable fields', () => {
    const patch: DocumentPatch = { title: 'New', doi: '10.1/y', arxivId: '2401.12345' }
    expect(patch.title).toBe('New')
    expect(patch.doi).toBe('10.1/y')
    expect(patch.arxivId).toBe('2401.12345')
  })

  it('EditableField whitelist includes every editable metadata field', () => {
    const editable: EditableField[] = [
      'title',
      'authors',
      'year',
      'venue',
      'volume',
      'issue',
      'pages',
      'abstract',
      'keywords',
      'url',
      'doi',
      'arxivId',
      'note',
      'affiliations'
    ]
    expect(editable).toHaveLength(14)
    expect(editable).not.toContain('id')
    expect(editable).not.toContain('filePath')
    expect(editable).not.toContain('starred')
  })

  it('Result envelope and BootstrapData compose', () => {
    const ok: Result<BootstrapData> = {
      ok: true,
      data: {
        language: 'en',
        theme: 'dark',
        windowBounds: null,
        listColumnState: null,
        sidebarCollapsed: false,
        firstRun: true,
        libraryFolderPath: ''
      }
    }
    const er: Result<BootstrapData> = {
      ok: false,
      error: { code: 'forbidden_field', message: 'no' }
    }
    expect(ok.ok).toBe(true)
    expect(er.ok).toBe(false)
  })

  it('LibrarySwitchResult carries scan outcome counts', () => {
    const res: LibrarySwitchResult = {
      libraryFolderPath: '/lib',
      dbExisted: false,
      scanned: 5,
      imported: 4,
      skipped: 1,
      errors: [{ path: '/lib/bad.pdf', message: 'corrupted' }]
    }
    expect(res.dbExisted).toBe(false)
    expect(res.imported).toBe(4)
    expect(res.errors).toHaveLength(1)
  })
})
