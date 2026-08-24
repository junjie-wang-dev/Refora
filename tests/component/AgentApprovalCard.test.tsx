import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentInterrupt, AgentInterruptAction } from '../../src/shared/ipc-types'
import i18n, { initI18n } from '../../src/renderer/i18n'
import AgentApprovalCard from '../../src/renderer/components/workspace/AgentApprovalCard'

function interrupt(actions: AgentInterruptAction[]): AgentInterrupt {
  return {
    id: 'interrupt-1',
    runId: 'run-1',
    threadId: 'thread-1',
    checkpointId: 'checkpoint-1',
    actions,
    status: 'pending',
    decision: null,
    createdAt: 1,
    resolvedAt: null
  }
}

describe('AgentApprovalCard', () => {
  beforeEach(async () => {
    initI18n('en')
    await i18n.changeLanguage('en')
    const w = window as unknown as { api: Record<string, Record<string, unknown>> }
    w.api.documents.get = vi.fn(async (docId: string) => docId === 'doc-ocr'
      ? { id: docId, title: 'Reliable Paper Parsing', fileName: 'paper.pdf' }
      : null)
  })

  afterEach(() => {
    cleanup()
  })

  it('shows concrete user-facing explanations for every approval action', async () => {
    const onResolve = vi.fn(async () => undefined)
    render(
      <AgentApprovalCard
        interrupt={interrupt([
          {
            name: 'prepare_paper_ocr',
            args: { docId: 'doc-ocr' },
            allowedDecisions: ['approve', 'reject']
          },
          {
            name: 'install_runtime_packages',
            args: {
              runtimes: ['python'],
              python: [
                { name: 'pygame', version: '2.5.2' },
                { name: 'pandas' }
              ],
              node: [{ name: 'typescript', version: '5.9.3' }]
            },
            allowedDecisions: ['approve', 'reject']
          },
          {
            name: 'publish_workspace_artifacts',
            args: {
              paths: [
                'outputs/report.md',
                'outputs/chart.png',
                'outputs/data.csv',
                'outputs/figure-1.png',
                'outputs/figure-2.png',
                'outputs/notes.md'
              ],
              x: 120,
              y: 240
            },
            allowedDecisions: ['approve', 'reject']
          },
          {
            name: 'propose_workspace_memory_update',
            args: {
              path: '/preferences.md',
              content: 'Keep paper summaries concise.',
              rationale: 'Match the preferred response style.'
            },
            allowedDecisions: ['approve', 'edit', 'reject']
          }
        ])}
        activeWorkspaceId="ws-1"
        streaming={false}
        onResolve={onResolve}
      />
    )

    const card = screen.getByTestId('agent-approval-card')
    expect(card).toHaveClass('mx-auto', 'w-full', 'max-w-[768px]', 'border-accent', 'bg-panel')
    expect(await screen.findByText(/^The Agent wants to run OCR on/)).toHaveTextContent(
      'The Agent wants to run OCR on “Reliable Paper Parsing”'
    )
    expect(card).toHaveTextContent('Python 3.12')
    expect(card).toHaveTextContent('Node.js 24')
    expect(card).toHaveTextContent('Python packages to install')
    expect(card).toHaveTextContent('pygame (version 2.5.2)')
    expect(card).toHaveTextContent('pandas (version not specified)')
    expect(card).toHaveTextContent('Node.js packages to install')
    expect(card).toHaveTextContent('typescript (version 5.9.3)')
    expect(card).toHaveTextContent('outputs/report.md')
    expect(card).toHaveTextContent('outputs/notes.md')
    expect(card).toHaveTextContent('x: 120, y: 240')
    expect(card).toHaveTextContent('Keep paper summaries concise.')
    expect(card).not.toHaveTextContent('doc-ocr')
    expect(card).not.toHaveTextContent('"paths"')
    expect(card.querySelector('pre')).toBeNull()

    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(2)
    expect(buttons[0]).toHaveClass('h-8', 'min-w-20')
    expect(buttons[1]).toHaveClass('h-8', 'min-w-20')
  })

  it('edits memory through readable fields and keeps only approve and reject actions', async () => {
    const onResolve = vi.fn(async () => undefined)
    render(
      <AgentApprovalCard
        interrupt={interrupt([
          {
            name: 'propose_workspace_memory_update',
            args: {
              path: '/brief.md',
              content: 'Initial research goal',
              rationale: 'Continue this project later'
            },
            allowedDecisions: ['approve', 'edit', 'reject']
          }
        ])}
        activeWorkspaceId="ws-1"
        streaming={false}
        onResolve={onResolve}
      />
    )

    fireEvent.change(screen.getByLabelText('Information to remember'), {
      target: { value: 'Updated research goal' }
    })
    fireEvent.change(screen.getByLabelText('Save under'), {
      target: { value: '/decisions.md' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save and approve' }))

    await waitFor(() => expect(onResolve).toHaveBeenCalledWith('edit', [{
      name: 'propose_workspace_memory_update',
      args: {
        path: '/decisions.md',
        content: 'Updated research goal',
        rationale: 'Continue this project later'
      }
    }]))
    expect(screen.getAllByRole('button')).toHaveLength(2)
  })

  it('shows every argument for an unfamiliar approval without raw JSON', () => {
    render(
      <AgentApprovalCard
        interrupt={interrupt([
          {
            name: 'future_reviewed_action',
            args: {
              target: 'workspace',
              options: { mode: 'safe', retry: true },
              labels: ['first', 'second']
            },
            allowedDecisions: ['approve', 'reject']
          }
        ])}
        activeWorkspaceId="ws-1"
        streaming={false}
        onResolve={vi.fn(async () => undefined)}
      />
    )

    const card = screen.getByTestId('agent-approval-card')
    expect(card).toHaveTextContent('Additional setting: target')
    expect(card).toHaveTextContent('workspace')
    expect(card).toHaveTextContent('mode: safe · retry: Yes')
    expect(card).toHaveTextContent('first')
    expect(card).toHaveTextContent('second')
    expect(card.querySelector('pre')).toBeNull()
  })
})
