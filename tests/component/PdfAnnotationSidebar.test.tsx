import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

  it.each(['idle', 'saving', 'saved', 'error'] as const)('does not render a persistence status in the sidebar for %s', (status) => {
    usePdfReaderStore.setState({ loadStatus: { paper: 'loaded' }, saveStatus: { paper: status } })
    const view = render(
      <PdfAnnotationSidebar
        annotations={[]}
        documentId="paper"
        overlay={false}
        onClose={vi.fn()}
        onNavigate={vi.fn()}
      />
    )

    expect(screen.queryByText(/^pdfReader\.saveStatus\./)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'pdfReader.retrySave' })).not.toBeInTheDocument()
    expect(view.container.querySelector('[aria-live]')).toBeNull()
    expect(screen.getByText('pdfReader.noAnnotationsTitle')).toBeInTheDocument()
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

  it('undoes an entire comment editing session and lists annotations in reading order', () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true, value: vi.fn()
    })
    usePdfReaderStore.setState({
      loadStatus: { paper: 'loaded' },
      annotations: { paper: [
        {
          id: 'lower', kind: 'note', page: 1, color: '#ff0', text: 'Lower note',
          comment: '', createdAt: 1, point: { x: 0.1, y: 0.8 }
        },
        {
          id: 'upper', kind: 'note', page: 1, color: '#ff0', text: 'Upper note',
          comment: 'Original', createdAt: 2, point: { x: 0.1, y: 0.2 }
        }
      ] }
    })
    function Sidebar() {
      const annotations = usePdfReaderStore((state) => state.annotations.paper)
      return <PdfAnnotationSidebar
        annotations={annotations}
        documentId="paper"
        overlay={false}
        onClose={vi.fn()}
        onNavigate={vi.fn()}
      />
    }
    const view = render(<Sidebar />)
    expect(Array.from(view.container.querySelectorAll<HTMLElement>('[data-annotation-card]'))
      .map((element) => element.dataset.annotationCard)).toEqual(['upper', 'lower'])
    const editor = screen.getByDisplayValue('Original')
    fireEvent.focus(editor)
    fireEvent.change(editor, { target: { value: 'First edit' } })
    fireEvent.change(editor, { target: { value: 'Complete revised comment' } })
    fireEvent.blur(editor)
    expect(usePdfReaderStore.getState().annotationHistory.paper.past).toHaveLength(1)
    act(() => usePdfReaderStore.getState().undo('paper'))
    expect(editor).toHaveValue('Original')
  })
})
