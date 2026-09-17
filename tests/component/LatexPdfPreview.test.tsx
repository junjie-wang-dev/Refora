import { createRef, useImperativeHandle } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import LatexPdfPreview, { type LatexPdfPreviewHandle } from '../../src/renderer/components/latex/LatexPdfPreview'
import type { PdfReaderHandle } from '../../src/renderer/components/PdfReader'
import type { ComponentProps, Ref } from 'react'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const observed = vi.hoisted(() => ({ props: null as ComponentProps<typeof import('../../src/renderer/components/PdfReader').default> | null }))
vi.mock('../../src/renderer/components/PdfReader', () => ({ default: (props: ComponentProps<typeof import('../../src/renderer/components/PdfReader').default> & { ref?: Ref<PdfReaderHandle> }) => {
  observed.props = props
  useImperativeHandle(props.ref, () => ({ getPosition: async () => ({ page: 2, x: 100, y: 200 }) }))
  return <div data-testid="shared-reader"><button onClick={() => props.onPageDoubleClick?.({ page: 2, x: 100, y: 200 })}>PDF double-click</button><button onClick={props.onDownload}>Download</button></div>
} }))
afterEach(cleanup)

it('delegates rendering and both navigation directions to the shared reader', async () => {
  const handle = createRef<LatexPdfPreviewHandle>()
  const locate = vi.fn()
  const download = vi.fn()
  const target = { request: 1, box: { path: 'section.tex', page: 2, line: 3, x: 100, y: 200, width: 80, height: 12 } }
  const view = render(<LatexPdfPreview ref={handle} documentId="latex:project" data="cGRm" syncEnabled target={target} onLocateSource={locate} onDownload={download} />)
  expect(screen.getByTestId('shared-reader')).toBeInTheDocument()
  expect(observed.props?.source).toEqual({ id: 'latex:project', title: 'LaTeX PDF', data: new Uint8Array([112, 100, 102]) })
  expect(observed.props?.location).toBe(target)
  expect(observed.props?.embedded).toBe(true)
  expect(observed.props?.variant).toBe('preview')
  fireEvent.click(screen.getByText('PDF double-click'))
  act(() => handle.current!.locateSource())
  await waitFor(() => expect(locate).toHaveBeenCalledTimes(2))
  expect(locate).toHaveBeenLastCalledWith(2, 100, 200)
  fireEvent.click(screen.getByText('Download'))
  expect(download).toHaveBeenCalledOnce()
  view.rerender(<LatexPdfPreview ref={handle} documentId="latex:project" data="cGRm" stale syncEnabled={false} target={target} onLocateSource={locate} />)
  expect(observed.props?.location).toBeNull()
  expect(observed.props?.onPageDoubleClick).toBeUndefined()
  expect(screen.getByText('latex.previewStale')).toBeInTheDocument()
  act(() => handle.current!.locateSource())
  expect(locate).toHaveBeenCalledTimes(2)
})
