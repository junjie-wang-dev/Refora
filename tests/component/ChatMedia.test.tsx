import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ReactMarkdown from 'react-markdown'
import { ChatMedia, ChatMediaCard, ChatMediaContextProvider, MarkdownMediaComponents } from '../../src/renderer/components/workspace/ChatMedia'
import { ToolResultCards } from '../../src/renderer/components/workspace/ToolResultCards'
import type { AgentTraceStep, ChatMediaItem, ChatMediaResource } from '../../src/shared/ipc-types'
import { initI18n } from '../../src/renderer/i18n'
import { useWorkspaceStore } from '../../src/renderer/store/workspaceStore'

initI18n('en')
const resource: ChatMediaResource = { id: 'cached-image', url: 'refora-asset://media/cached-image', kind: 'image', fileName: 'figure.png', mimeType: 'image/png', byteLength: 2048 }
const media: ChatMediaItem = { id: 'image-1', kind: 'image', title: 'Experiment result', source: { type: 'asset', assetId: 'asset-1' } }
const resolveMedia = vi.fn()

beforeEach(() => {
  resolveMedia.mockReset().mockResolvedValue(resource)
  window.api.ai.resolveMedia = resolveMedia
  window.api.ai.mediaTextPreview = vi.fn().mockResolvedValue({ content: '', truncated: false })
  window.api.ai.openMedia = vi.fn().mockResolvedValue(undefined)
  window.api.ai.saveMedia = vi.fn().mockResolvedValue(true)
  window.api.ai.copyMedia = vi.fn().mockResolvedValue(undefined)
  window.api.ai.revealMedia = vi.fn().mockResolvedValue(undefined)
})
afterEach(cleanup)

it('resolves a local image, previews it, zooms in a modal, and restores focus on close', async () => {
  render(<ChatMedia media={[media]} />)
  const image = await screen.findByRole('img', { name: 'Experiment result' })
  expect(image).toHaveAttribute('src', resource.url)
  expect(image).toHaveAttribute('loading', 'lazy')
  fireEvent.load(image)
  expect(screen.queryByText('Loading preview…')).not.toBeInTheDocument()
  const button = screen.getByRole('button', { name: 'Enlarge Experiment result' })
  button.focus()
  fireEvent.click(button)
  const viewer = screen.getByRole('dialog', { name: 'Experiment result' })
  fireEvent.click(within(viewer).getByRole('button', { name: 'Zoom in' }))
  expect(within(viewer).getByRole('button', { name: 'Fit image' })).toHaveTextContent('125%')
  fireEvent.keyDown(viewer, { key: '0' })
  expect(within(viewer).getByRole('button', { name: 'Fit image' })).toHaveTextContent('100%')
  const close = within(viewer).getByRole('button', { name: 'Close image viewer' })
  const zoomOut = within(viewer).getByRole('button', { name: 'Zoom out' })
  close.focus()
  fireEvent.keyDown(close, { key: 'Tab' })
  expect(zoomOut).toHaveFocus()
  fireEvent.keyDown(zoomOut, { key: 'Tab', shiftKey: true })
  expect(close).toHaveFocus()
  fireEvent.keyDown(viewer, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(button).toHaveFocus()
})

it('keeps external media unloaded until requested and does not auto-load a changed source', async () => {
  const item: ChatMediaItem = { ...media, source: { type: 'remote', url: 'https://example.com/figure.png' } }
  const { rerender } = render(<ChatMediaCard item={item} />)
  expect(resolveMedia).not.toHaveBeenCalled()
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Load external media' }))
  await screen.findByRole('img')
  expect(resolveMedia).toHaveBeenCalledTimes(1)
  rerender(<ChatMediaCard item={{ ...item, source: { type: 'remote', url: 'https://second.example/secret.png' } }} />)
  expect(screen.getByRole('button', { name: 'Load external media' })).toBeInTheDocument()
  await act(async () => { await Promise.resolve() })
  expect(resolveMedia).toHaveBeenCalledTimes(1)
})

it('shows resolver failures with a successful retry', async () => {
  resolveMedia.mockRejectedValueOnce(new Error('The file is unavailable'))
  render(<ChatMedia media={[media]} />)
  expect(await screen.findByText('The file is unavailable')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(await screen.findByRole('img')).toHaveAttribute('src', resource.url)
  expect(resolveMedia).toHaveBeenCalledTimes(2)
})

it('provides image copy, save, open and Finder actions with controlled resource IDs', async () => {
  render(<ChatMedia media={[media]} />)
  await screen.findByRole('img')
  for (const label of ['Copy', 'Save a copy', 'Open file', 'Show in Finder']) {
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: label })) })
  }
  expect(window.api.ai.copyMedia).toHaveBeenCalledWith(resource.id)
  expect(window.api.ai.saveMedia).toHaveBeenCalledWith(resource.id)
  expect(window.api.ai.openMedia).toHaveBeenCalledWith(resource.id)
  expect(window.api.ai.revealMedia).toHaveBeenCalledWith(resource.id)
})

it('renders native audio/video controls and file cards', async () => {
  resolveMedia.mockImplementation(async ({ kind }: { kind: string }) => ({ ...resource, kind, fileName: `${kind}.sample`, mimeType: `${kind}/sample` }))
  const { container } = render(<ChatMedia media={(['audio', 'video', 'file'] as const).map((kind) => ({ ...media, id: kind, title: kind, kind }))} />)
  await waitFor(() => expect(container.querySelector('audio')).toHaveAttribute('controls'))
  expect(container.querySelector('video')).toHaveAttribute('controls')
  expect(container.querySelector('audio')).toHaveAttribute('preload', 'metadata')
  expect(container.querySelector('video')).not.toHaveAttribute('autoplay')
  expect(screen.getAllByRole('button', { name: 'Save a copy' })).toHaveLength(3)
})

it('offers preview and save for scripts without launching them through asset captions', async () => {
  resolveMedia.mockResolvedValue({ ...resource, kind: 'file', fileName: 'script.py', mimeType: 'text/x-python' })
  const openAsset = vi.spyOn(window.api.workspaceAssets, 'open')
  render(<ChatMedia media={[{ ...media, kind: 'file', title: 'script.py' }]} />)
  await screen.findByRole('button', { name: 'Preview file' })
  expect(screen.queryByRole('button', { name: 'Open file' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'script.py' })).not.toBeInTheDocument()
  expect(openAsset).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Save a copy' })).toBeInTheDocument()
  openAsset.mockRestore()
})

it('previews CSV files with quoted fields and returns to the workspace', async () => {
  resolveMedia.mockResolvedValue({ ...resource, kind: 'file', fileName: 'results.csv', mimeType: 'text/csv' })
  window.api.ai.mediaTextPreview = vi.fn().mockResolvedValue({ content: 'Model,Note,Score\nA,"two, experiments",0.95\nB,"quoted ""result""",0.90', truncated: true })
  const showWorkspace = vi.spyOn(useWorkspaceStore.getState(), 'showWorkspace').mockImplementation(() => undefined)
  render(<ChatMedia media={[{ ...media, kind: 'file', title: 'results.csv' }]} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Preview file' }))
  expect(await screen.findByRole('cell', { name: 'two, experiments' })).toBeInTheDocument()
  expect(screen.getByRole('cell', { name: 'quoted "result"' })).toBeInTheDocument()
  expect(screen.getByText('Preview is limited. Open or save the file to view all data.')).toBeInTheDocument()
  expect(window.api.ai.mediaTextPreview).toHaveBeenCalledWith(resource.id)
  fireEvent.click(screen.getByRole('button', { name: 'Show in workspace' }))
  expect(showWorkspace).toHaveBeenCalledOnce()
  showWorkspace.mockRestore()
})

it('retains unavailable provider output as a readable card without a request', () => {
  render(<ChatMedia media={[{ ...media, source: { type: 'unavailable', reason: 'Provider returned an unsupported media format' } }]} />)
  expect(screen.getByText('Provider returned an unsupported media format')).toBeInTheDocument()
  expect(resolveMedia).not.toHaveBeenCalled()
})

it('resolves relative OCR images using the surrounding conversation context', async () => {
  render(<ChatMediaContextProvider value={{ documentId: 'paper-1', resultKey: 'ocr-1', runId: 'run-1' }}>
    <ReactMarkdown components={MarkdownMediaComponents}>{'![Paper figure](images/figure.png)'}</ReactMarkdown>
  </ChatMediaContextProvider>)
  await screen.findByRole('img', { name: 'Paper figure' })
  expect(resolveMedia).toHaveBeenCalledWith(expect.objectContaining({ source: { type: 'ocr', documentId: 'paper-1', resultKey: 'ocr-1', path: 'assets/figure.png' }, runId: 'run-1' }))
  expect(screen.getByRole('button', { name: 'Return to source paper' })).toBeInTheDocument()
})

function trace(result: unknown): AgentTraceStep {
  return { id: 'step', threadId: 'thread', runId: 'run', kind: 'tool', name: 'search_documents', input: null, output: 'truncated diagnostic', result, status: 'done', startedAt: 0, endedAt: 1, seq: 1, inputTokens: null, outputTokens: null, totalTokens: null, parentStepId: null, agentName: null, namespace: null, depth: 0, checkpointId: null }
}

describe('rich tool results', () => {
  it('shows paper excerpts without calling character pagination more search results', () => {
    render(<ToolResultCards step={{ ...trace({ docId: 'paper', title: 'Paper excerpt', text: 'Evidence from the paper.', offset: 40000, totalChars: 80000, nextOffset: 60000 }), name: 'read_paper' }} />)
    expect(screen.getByText('Evidence from the paper.')).toBeInTheDocument()
    expect(screen.getByText('More paper text is available in the next chunk.')).toBeInTheDocument()
    expect(screen.queryByText('More results are available; ask the agent to continue.')).not.toBeInTheDocument()
  })

  it('honors exhausted search pages and deduplicates the same paper', () => {
    render(<ToolResultCards step={trace({ documents: [{ docId: 'paper', title: 'Single paper', abstract: 'Evidence' }, { docId: 'paper', title: 'Single paper' }], hasMore: false, nextOffset: 20 })} />)
    expect(screen.getAllByRole('button', { name: 'Single paper' })).toHaveLength(1)
    expect(screen.getByText('Evidence')).toBeInTheDocument()
    expect(screen.queryByText('More results are available; ask the agent to continue.')).not.toBeInTheDocument()
  })

  it('does not turn arbitrary status objects or non-output paths into downloadable results', () => {
    const { rerender } = render(<ToolResultCards step={trace({ status: 'ready', message: 'Finished', count: 3 })} />)
    expect(screen.queryByRole('region', { name: 'Data preview' })).not.toBeInTheDocument()
    rerender(<ToolResultCards step={trace({ path: '/scripts/private.py' })} />)
    expect(resolveMedia).not.toHaveBeenCalled()
    expect(screen.queryByText('Loading preview…')).not.toBeInTheDocument()
  })

  it('supports expanding and collapsing long result collections', () => {
    render(<ToolResultCards step={trace({ documents: Array.from({ length: 12 }, (_, index) => ({ docId: `doc-${index}`, title: `Paper ${index}` })) })} />)
    expect(screen.queryByRole('button', { name: 'Paper 11' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show more results' }))
    expect(screen.getByRole('button', { name: 'Paper 11' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show fewer results' }))
    expect(screen.queryByRole('button', { name: 'Paper 11' })).not.toBeInTheDocument()
  })
  it('uses complete structured search results instead of truncated trace text', () => {
    render(<ToolResultCards step={trace({ results: [{ title: 'Research source', url: 'https://example.com/paper', snippet: 'Evidence summary' }], hasMore: true })} />)
    expect(screen.getByRole('link', { name: 'Research source' })).toHaveAttribute('href', 'https://example.com/paper')
    expect(screen.getByText('Evidence summary')).toBeInTheDocument()
    expect(screen.getByText('More results are available; ask the agent to continue.')).toBeInTheDocument()
    expect(screen.queryByText('truncated diagnostic')).not.toBeInTheDocument()
  })

  it('renders citation graph paper identities as readable research cards', () => {
    render(<ToolResultCards step={trace({ items: [{ paper: { title: 'Related paper', authors: [{ name: 'Ada' }], year: 2026, arxivId: '2601.00001', abstract: 'A useful comparison' } }] })} />)
    expect(screen.getByRole('link', { name: 'Related paper' })).toHaveAttribute('href', 'https://arxiv.org/abs/2601.00001')
    expect(screen.getByText('Ada · 2026')).toBeInTheDocument()
    expect(screen.getByText('A useful comparison')).toBeInTheDocument()
  })

  it('opens generated reports in the workspace and rejects unsafe result links', () => {
    const open = vi.spyOn(useWorkspaceStore.getState(), 'openMarkdownCard').mockImplementation(() => undefined)
    render(<ToolResultCards step={trace([{ reportId: 'report-1', title: 'Comparison report', sourceDocIds: ['paper'] }, { title: 'Unsafe source', url: 'javascript:alert(1)' }])} />)
    fireEvent.click(screen.getByRole('button', { name: 'Comparison report' }))
    expect(open).toHaveBeenCalledWith('report', 'report-1')
    expect(screen.queryByRole('link', { name: 'Unsafe source' })).not.toBeInTheDocument()
    open.mockRestore()
  })

  it('avoids repeating assistant artifacts in tool cards and Markdown attachments', () => {
    render(<ChatMediaContextProvider value={{ runId: 'run' }} media={[media]}>
      <ToolResultCards step={trace({ published: [{ assetId: 'asset-1', fileName: 'plot.png' }] })} />
      <ChatMedia media={[media]} excludeMarkdown={'![Figure](refora-asset://asset/asset-1)'} />
    </ChatMediaContextProvider>)
    expect(screen.queryByRole('region', { name: 'Data preview' })).not.toBeInTheDocument()
    expect(screen.queryByText('Experiment result')).not.toBeInTheDocument()
    expect(resolveMedia).not.toHaveBeenCalled()
  })

  it('renders artifact previews and structured data tables', async () => {
    const { rerender } = render(<ToolResultCards step={trace({ artifacts: [{ assetId: 'plot', fileName: 'plot.png', mimeType: 'image/png' }] })} />)
    expect(await screen.findByRole('img', { name: 'plot.png' })).toBeInTheDocument()
    rerender(<ToolResultCards step={trace({ columns: ['Model', 'Accuracy'], rows: [['A', 0.95], ['B', 0.87]] })} />)
    expect(screen.getByRole('columnheader', { name: 'Accuracy' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: '0.95' })).toBeInTheDocument()
  })
})
