import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OcrJob } from '../../src/shared/mineru-types'
import OcrProgressCard from '../../src/renderer/components/OcrProgressCard'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}))

afterEach(cleanup)

function makeJob(patch: Partial<OcrJob> = {}): OcrJob {
  const now = Date.now()
  return {
    id: 'job-1',
    documentId: 'doc-1',
    resultKey: 'result-1',
    sourceHash: 'hash-1',
    profile: 'balanced',
    status: 'running',
    stage: 'parsing',
    progress: null,
    errorCode: null,
    errorMessage: null,
    createdAt: now - 5_000,
    startedAt: now - 5_000,
    finishedAt: null,
    updatedAt: now,
    ...patch
  }
}

describe('OcrProgressCard', () => {
  it('shows indeterminate progress when the current stage is not measurable', () => {
    render(<OcrProgressCard job={makeJob()} />)

    expect(screen.getByText('ocr.stage.parsing')).toBeInTheDocument()
    expect(screen.getByText('ocr.stageDescription.parsing')).toBeInTheDocument()
    const progress = screen.getByRole('progressbar', { name: 'ocr.progress' })
    expect(progress).not.toHaveAttribute('aria-valuenow')
    expect(progress.querySelector('.mineru-progress-indeterminate')).toBeInTheDocument()
  })

  it('renders measurable parsing progress in one continuous bar', () => {
    render(
      <OcrProgressCard
        job={makeJob({
          progress: 0.475
        })}
      />
    )

    const progress = screen.getByRole('progressbar', { name: 'ocr.progress' })
    expect(progress).toHaveAttribute('aria-valuenow', '48')
    expect(progress.firstElementChild).toHaveStyle({ width: '47.5%' })
    expect(screen.getByText(/48%/)).toBeInTheDocument()
  })
})
