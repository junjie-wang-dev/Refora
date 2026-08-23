import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Document } from '../../src/shared/ipc-types'
import { api } from '../../src/renderer/ipc'
import PdfAnnotationSidebar from '../../src/renderer/components/PdfAnnotationSidebar'
import { usePdfReaderStore } from '../../src/renderer/store/pdfReaderStore'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

const document = {
  id: 'paper',
  filePath: '/tmp/paper.pdf',
  fileName: 'paper.pdf'
} as Document

describe('PdfAnnotationSidebar', () => {
  beforeEach(() => {
    usePdfReaderStore.getState().resetForLibrarySwitch()
    usePdfReaderStore.setState({
      tabs: [document],
      activeDocumentId: document.id,
      annotations: {},
      loadStatus: { paper: 'error' },
      saveStatus: {}
    })
    vi.spyOn(api.documents, 'pdfAnnotations').mockResolvedValue([])
    vi.spyOn(api.documents, 'setPdfAnnotations').mockResolvedValue([])
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('retries a failed annotation read without writing an empty snapshot', async () => {
    render(
      <PdfAnnotationSidebar
        annotations={[]}
        documentId="paper"
        overlay={false}
        onClose={vi.fn()}
        onNavigate={vi.fn()}
      />
    )

    expect(screen.getByRole('alert')).toHaveTextContent('pdfReader.annotationLoadFailed')
    fireEvent.click(screen.getAllByRole('button', {
      name: 'pdfReader.retryLoadAnnotations'
    })[0])

    await waitFor(() => {
      expect(api.documents.pdfAnnotations).toHaveBeenCalledWith('paper')
      expect(usePdfReaderStore.getState().loadStatus.paper).toBe('loaded')
    })
    expect(api.documents.setPdfAnnotations).not.toHaveBeenCalled()
    expect(screen.getByText('pdfReader.noAnnotationsTitle')).toBeInTheDocument()
  })
})
