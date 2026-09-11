import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../src/renderer/i18n'

const mocks = vi.hoisted(() => ({
  listDeleted: vi.fn(), restoreDeleted: vi.fn(), fetchDocuments: vi.fn(),
  fetchDocumentCounts: vi.fn(), fetchCategories: vi.fn()
}))
vi.mock('@lobehub/ui', async () => import('../mocks/lobehub-ui'))
vi.mock('../../src/renderer/ipc', () => ({ api: {
  documents: mocks,
  events: { onLibrarySwitched: () => () => undefined }
} }))
vi.mock('../../src/renderer/store/documentStore', () => ({
  useDocumentStore: { getState: () => mocks }
}))
import DeletedDocumentsDialog from '../../src/renderer/components/DeletedDocumentsDialog'

describe('DeletedDocumentsDialog', () => {
  beforeEach(() => {
    initI18n('en')
    vi.clearAllMocks()
    mocks.listDeleted.mockResolvedValue([{ id: 'entry', deletedAt: 1, titles: ['Annotated paper'], count: 1 }])
    mocks.restoreDeleted.mockResolvedValue({ documentIds: ['doc'], skippedRelations: 0 })
  })
  afterEach(cleanup)

  it('restores an entry and refreshes library views', async () => {
    render(<DeletedDocumentsDialog onClose={vi.fn()} />)
    await screen.findByText('Annotated paper')
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    await waitFor(() => expect(mocks.restoreDeleted).toHaveBeenCalledWith('entry'))
    await waitFor(() => expect(screen.queryByText('Annotated paper')).not.toBeInTheDocument())
    expect(mocks.fetchDocuments).toHaveBeenCalledOnce()
    expect(mocks.fetchCategories).toHaveBeenCalledOnce()
  })

  it('keeps failed entries available for retry', async () => {
    mocks.restoreDeleted.mockRejectedValue(new Error('Recovery copy is missing'))
    render(<DeletedDocumentsDialog onClose={vi.fn()} />)
    await screen.findByText('Annotated paper')
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Recovery copy is missing')
    expect(screen.getByText('Annotated paper')).toBeInTheDocument()
    expect(mocks.fetchDocuments).not.toHaveBeenCalled()
  })
})
