import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentTraceStepItem } from '../../src/renderer/components/workspace/AgentTrace'
import ChatMessages from '../../src/renderer/components/workspace/ChatMessages'
import { initI18n } from '../../src/renderer/i18n'
import type { AgentTraceStep, ChatMediaItem } from '../../src/shared/ipc-types'

initI18n('en')
const step = (patch: Partial<AgentTraceStep> = {}): AgentTraceStep => ({
  id: 'tool', threadId: 'thread', runId: 'run', kind: 'tool', name: 'get_paper_context',
  input: '{"docId":"opaque-paper-id"}', output: null, result: null, status: 'done',
  startedAt: 1, endedAt: 2, seq: 1, inputTokens: null, outputTokens: null, totalTokens: null,
  parentStepId: null, agentName: null, namespace: null, depth: 0, checkpointId: null, ...patch
})

beforeEach(() => {
  window.api.ai.resolveMedia = vi.fn().mockImplementation(async ({ kind }) => ({
    id: 'resource', url: 'refora-asset://media/resource', kind, fileName: 'file',
    mimeType: kind === 'image' ? 'image/png' : 'text/csv', byteLength: 20
  }))
})
afterEach(cleanup)

describe('tool detail presentation', () => {
  it('uses the actual text chunk and extraction source in paper read labels', () => {
    const { rerender } = render(<AgentTraceStepItem step={step({ name: 'read_paper', input: '{"docId":"paper","offset":40000}' })} />)
    expect(screen.getByRole('button', { name: /Read document \(chunk 2\)/ })).toBeInTheDocument()
    rerender(<AgentTraceStepItem step={step({ name: 'read_paper', result: { title: 'Paper', chunkIndex: 3, source: 'mineru_ocr', text: 'OCR evidence' } })} />)
    fireEvent.click(screen.getByRole('button', { name: /Read OCR cache \(chunk 4\)/ }))
    expect(screen.getByText('OCR text')).toBeInTheDocument()
  })
  it('uses paper titles and readable output, with JSON behind a secondary disclosure', () => {
    render(<AgentTraceStepItem step={step({ result: { docId: 'opaque-paper-id', title: 'FlashDrive', abstract: 'Evidence summary' } })} />)
    expect(screen.queryByText('opaque-paper-id')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Retrieved metadata.*FlashDrive/ }))
    expect(screen.getByText('Evidence summary')).toBeInTheDocument()
    expect(screen.queryByText(/"docId"/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Technical details' }))
    expect(screen.getAllByText(/"docId"/)).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: /Retrieved metadata.*FlashDrive/ }))
    expect(screen.queryByText('Evidence summary')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Retrieved metadata.*FlashDrive/ }))
    expect(screen.queryByText(/"docId"/)).not.toBeInTheDocument()
  })

  it('shows commands and execution output without dumping their wrapper JSON', () => {
    render(<AgentTraceStepItem step={step({ name: '__execute', input: JSON.stringify({ command: 'python analyze.py', timeoutSeconds: 10 }), result: { exitCode: 0, stdout: 'Processed 12 rows' } })} />)
    fireEvent.click(screen.getByRole('button', { name: /Ran command/ }))
    expect(screen.getByText('Processed 12 rows')).toBeInTheDocument()
    expect(screen.getByText('Command finished · exit code 0')).toBeInTheDocument()
    expect(screen.queryByText(/"stdout"/)).not.toBeInTheDocument()
  })

  it('keeps failures readable without requiring technical details', () => {
    render(<AgentTraceStepItem step={step({ name: 'web_fetch', status: 'error', input: '{"url":"https://example.com/paper"}', result: { error: { code: 'network', message: 'The source could not be reached' } } })} />)
    fireEvent.click(document.querySelector('.agent-trace-step-trigger')!)
    expect(screen.getByText('The source could not be reached')).toBeInTheDocument()
    expect(screen.queryByText(/"code"/)).not.toBeInTheDocument()
  })

  it.each([true, false])('folds tool-owned images and files at both levels (explicit ownership: %s)', async (explicit) => {
    const media: ChatMediaItem[] = [
      { id: 'chart', kind: 'image', title: 'Tool chart', source: { type: 'asset', assetId: 'chart' }, ...(explicit ? { toolStepId: 'tool' } : {}) },
      { id: 'file', kind: 'file', title: 'Tool file', source: { type: 'asset', assetId: 'file' }, ...(explicit ? { toolStepId: 'tool' } : {}) }
    ]
    render(<ChatMessages
      messages={[{ id: 'answer', threadId: 'thread', role: 'assistant', runId: 'run', content: 'Readable final answer', createdAt: 3, media,
        attachments: [{ type: 'asset', assetId: 'chart', title: 'Tool chart' }] }]}
      traceSteps={[step({ name: 'publish_workspace_artifacts', result: { published: [{ assetId: 'chart', fileName: 'Tool chart' }, { assetId: 'file', fileName: 'Tool file' }] } })]}
      streaming={false} streamingText="" streamingReasoning="" activeRunId={null} elapsedSeconds={0} loadingHistory={false}
      providers={[]} onRegenerate={vi.fn()} onSuggestionClick={vi.fn()} scrollRef={{ current: null }} inputAreaHeight={0} stickToBottomRef={{ current: true }}
    />)
    expect(screen.queryByText('Tool chart')).not.toBeInTheDocument()
    expect(window.api.ai.resolveMedia).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Show details' }))
    expect(screen.queryByText('Tool chart')).not.toBeInTheDocument()
    fireEvent.click(document.querySelector('.agent-trace-step-trigger')!)
    await waitFor(() => expect(screen.getByRole('img', { name: 'Tool chart' })).toBeInTheDocument())
    expect(screen.getAllByText('Tool file').length).toBeGreaterThan(0)
    fireEvent.click(document.querySelector('.agent-trace-step-trigger')!)
    expect(screen.queryByRole('img', { name: 'Tool chart' })).not.toBeInTheDocument()
    fireEvent.click(document.querySelector('.agent-trace-step-trigger')!)
    fireEvent.click(screen.getByRole('button', { name: 'Hide details' }))
    expect(screen.queryByText('Tool file')).not.toBeInTheDocument()
    expect(screen.getByText('Readable final answer')).toBeInTheDocument()
  })
})

it('presents compact paper reads using the actual action and nested parameters', () => {
  render(<AgentTraceStepItem step={step({ name: 'refora_library', input: JSON.stringify({ action: 'read', parameters: { docId: 'paper', offset: 40000 } }), result: { docId: 'paper', text: 'Second chunk', source: 'extracted', chunkIndex: 1 } })} />)
  fireEvent.click(screen.getByRole('button', { name: /Read document \(chunk 2\)/ }))
  expect(screen.getByText('Second chunk')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Technical details' }))
  expect(screen.getByText(/"action": "read"/)).toBeInTheDocument()
})
