import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Document } from '../../src/shared/ipc-types'
import type { OcrDocumentState, OcrJob, OcrProgressEvent } from '../../src/shared/mineru-types'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

vi.mock('@lobehub/ui', async () => import('../mocks/lobehub-ui'))

const OcrSection = (await import('../../src/renderer/components/OcrSection')).default

describe('OcrSection', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('applies progress events directly without reloading the full OCR state', async () => {
    const doc = {
      id: 'doc-ocr',
      fileName: 'scan.pdf',
      title: 'Scan'
    } as Document
    const state = {
      engine: { state: 'installed' },
      activeJob: null,
      result: null
    } as OcrDocumentState
    const getState = vi.fn().mockResolvedValue(state)
    let progressHandler: ((payload: OcrProgressEvent) => void) | undefined
    vi.spyOn(window.api.ocr, 'getState').mockImplementation(getState)
    vi.spyOn(window.api.events, 'onOcrProgress').mockImplementation((handler) => {
      progressHandler = handler
      return vi.fn()
    })
    const job = {
      id: 'job-1',
      documentId: doc.id,
      resultKey: 'result-1',
      sourceHash: 'hash',
      profile: 'balanced',
      status: 'running',
      stage: 'parsing',
      progress: 0.5,
      errorCode: null,
      errorMessage: null,
      createdAt: 1,
      startedAt: 1,
      finishedAt: null,
      updatedAt: 2
    } satisfies OcrJob

    render(<OcrSection doc={doc} />)
    await waitFor(() => expect(getState).toHaveBeenCalledTimes(1))

    act(() => progressHandler?.({ job }))

    expect(getState).toHaveBeenCalledTimes(1)
  })

  it('keeps a progress event when the initial state request finishes late', async () => {
    const doc = { id: 'doc-late', fileName: 'late.pdf', title: 'Late' } as Document
    const state = {
      engine: { state: 'installed' },
      activeJob: null,
      result: null
    } as OcrDocumentState
    let resolveInitial: ((state: OcrDocumentState) => void) | undefined
    const getState = vi.fn()
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveInitial = resolve
      }))
      .mockResolvedValueOnce(state)
    let progressHandler: ((payload: OcrProgressEvent) => void) | undefined
    vi.spyOn(window.api.ocr, 'getState').mockImplementation(getState)
    vi.spyOn(window.api.events, 'onOcrProgress').mockImplementation((handler) => {
      progressHandler = handler
      return vi.fn()
    })
    const job = {
      id: 'job-late',
      documentId: doc.id,
      resultKey: 'result-late',
      sourceHash: 'hash',
      profile: 'balanced',
      status: 'running',
      stage: 'parsing',
      progress: 0.6,
      errorCode: null,
      errorMessage: null,
      createdAt: 1,
      startedAt: 1,
      finishedAt: null,
      updatedAt: 2
    } satisfies OcrJob

    render(<OcrSection doc={doc} />)
    await waitFor(() => expect(progressHandler).toBeDefined())
    act(() => progressHandler?.({ job }))
    await waitFor(() => expect(getState).toHaveBeenCalledTimes(2))
    expect(await screen.findByRole('progressbar')).toHaveAttribute('aria-valuenow', '60')

    await act(async () => {
      resolveInitial?.(state)
      await Promise.resolve()
    })

    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '60')
  })
})
