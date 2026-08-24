import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, opts?: Record<string, unknown> | string) => {
    if (typeof opts === 'string') return opts
    if (opts && typeof opts === 'object' && 'defaultValue' in opts) { let s = String(opts.defaultValue); for (const [kk, vv] of Object.entries(opts)) { if (kk !== 'defaultValue') s = s.replace(new RegExp('{{' + kk + '}}', 'g'), String(vv)); } return s; }
    if (opts && typeof opts === 'object' && 'count' in opts) return `Total: ${opts.count} tokens`
    return k
  }})
}))

import { AgentTracePanel } from '../../src/renderer/components/workspace/AgentTrace'
import type { AgentTraceStep } from '../../src/shared/ipc-types'

function step(over: Partial<AgentTraceStep> = {}): AgentTraceStep {
  return {
    id: 's1', threadId: 't', runId: 'r', kind: 'llm', name: null,
    input: null, output: null, status: 'done', startedAt: 1000, endedAt: 2000,
    seq: 0, inputTokens: null, outputTokens: null, totalTokens: null,
    parentStepId: null, agentName: null, namespace: null, depth: 0, checkpointId: null,
    ...over
  }
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(cleanup)

function headerButton() {
  return document.querySelector('button[aria-expanded]') as HTMLButtonElement
}

describe('AgentTracePanel', () => {
  it('renders nothing when no steps and not streaming', () => {
    const { container } = render(<AgentTracePanel steps={[]} streaming={false} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders the panel header when streaming with no visible steps', () => {
    render(<AgentTracePanel steps={[]} streaming={true} />)
    expect(headerButton()).not.toBeNull()
  })

  it('shows step count in header', () => {
    render(<AgentTracePanel steps={[step({ id: 'a' }), step({ id: 'b' })]} streaming={false} />)
    expect(headerButton().textContent).toContain('2')
  })

  it('expands to show steps on header click', () => {
    const steps = [step({ id: 'a', kind: 'llm' }), step({ id: 'b', kind: 'tool', name: 'search_documents', input: JSON.stringify({ query: '', scope: 'library' }) })]
    render(<AgentTracePanel steps={steps} streaming={false} />)
    expect(headerButton().getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(headerButton())
    expect(headerButton().getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Searched library')).toBeInTheDocument()
  })

  it('auto-expands when streaming starts with steps', () => {
    render(<AgentTracePanel steps={[step({ id: 'a', status: 'running' })]} streaming={true} />)
    expect(headerButton().getAttribute('aria-expanded')).toBe('true')
  })

  it('shows total duration derived from visible steps', () => {
    const steps = [step({ id: 'a', startedAt: 1000, endedAt: 3500 })]
    render(<AgentTracePanel steps={steps} streaming={false} />)
    expect(headerButton().textContent).toContain('2.5s')
  })

  it('shows token total when steps have totalTokens', () => {
    const steps = [step({ id: 'a', totalTokens: 500 }), step({ id: 'b', totalTokens: 250 })]
    render(<AgentTracePanel steps={steps} streaming={false} />)
    expect(headerButton().textContent).toContain('Total: 750 tokens')
  })

  it('hides run-kind steps from visible count', () => {
    const steps = [step({ id: 'run', kind: 'run' }), step({ id: 'a', kind: 'llm' })]
    render(<AgentTracePanel steps={steps} streaming={false} />)
    expect(headerButton().textContent).toContain('1')
  })

  it('shows running label when a step is still running', () => {
    render(<AgentTracePanel steps={[step({ id: 'a', status: 'running', endedAt: null })]} streaming={false} />)
    expect(headerButton().textContent).toContain('running…')
  })

  it('does not show running label when a step errored', () => {
    render(<AgentTracePanel steps={[step({ id: 'a', status: 'error' })]} streaming={false} />)
    expect(headerButton().textContent).not.toContain('running…')
  })

  it('expand all toggles step body visibility', () => {
    const steps = [step({ id: 'a', input: 'IN-A', output: 'OUT-A' })]
    render(<AgentTracePanel steps={steps} streaming={false} />)
    fireEvent.click(headerButton())
    expect(screen.queryByText('IN-A')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Expand all'))
    expect(screen.getByText('IN-A')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Collapse all'))
    expect(screen.queryByText('IN-A')).not.toBeInTheDocument()
  })

  it('labels execution, dependency installation, and artifact publishing steps', () => {
    const steps = [
      step({ id: 'bash', kind: 'tool', name: 'run_bash' }),
      step({ id: 'python-execute', kind: 'tool', name: '__execute' }),
      step({ id: 'install', kind: 'tool', name: 'install_runtime_packages' }),
      step({ id: 'publish', kind: 'tool', name: 'publish_workspace_artifacts' })
    ]
    render(<AgentTracePanel steps={steps} streaming={false} />)
    fireEvent.click(headerButton())
    expect(screen.getAllByText('Ran command')).toHaveLength(2)
    expect(screen.getByText('Installed packages')).toBeInTheDocument()
    expect(screen.getByText('Published artifacts')).toBeInTheDocument()
  })

  it('normalizes Codex CLI tool names to the shared API labels', () => {
    const steps = [
      step({ id: 'search', kind: 'tool', name: 'refora.search_documents', input: JSON.stringify({ query: 'agents', scope: 'workspace' }) }),
      step({ id: 'shell', kind: 'tool', name: 'codex_shell', input: JSON.stringify({ command: 'pwd' }) }),
      step({ id: 'web', kind: 'tool', name: 'native_web_search', input: JSON.stringify({ query: 'new papers' }) })
    ]
    render(<AgentTracePanel steps={steps} streaming={false} />)
    fireEvent.click(headerButton())

    expect(screen.getByText('Searched workspace')).toBeInTheDocument()
    expect(screen.getByText('“agents”')).toBeInTheDocument()
    expect(screen.getByText('Ran command')).toBeInTheDocument()
    expect(screen.getByText('Searched the web')).toBeInTheDocument()
  })

  it('shows the executed command in the collapsed row and preserves raw JSON details', () => {
    const input = JSON.stringify({
      input: JSON.stringify({
        script: 'echo "PWD: $(pwd)"\nls -la',
        timeoutSeconds: 10
      })
    })
    render(<AgentTracePanel steps={[
      step({
        id: 'execute',
        kind: 'tool',
        name: 'execute',
        input,
        output: '{"exitCode":0}'
      })
    ]} streaming={false} />)

    fireEvent.click(headerButton())

    expect(screen.getByText('Ran command')).toBeInTheDocument()
    expect(screen.getByText('echo "PWD: $(pwd)" ls -la')).toBeInTheDocument()
    expect(screen.queryByText(/"timeoutSeconds": 10/)).toBeNull()

    fireEvent.click(screen.getByText('Ran command').closest('button')!)

    const details = document.querySelectorAll('.agent-trace-detail-value')
    expect(details[0].textContent).toBe(JSON.stringify(JSON.parse(input), null, 2))
    expect(details[1].textContent).toBe('{\n  "exitCode": 0\n}')
  })

  it('shows the visited website without exposing URL query data until expanded', () => {
    const input = JSON.stringify({
      url: 'https://docs.example.com/guide/?token=secret'
    })
    render(<AgentTracePanel steps={[
      step({
        id: 'website',
        kind: 'tool',
        name: 'fetch_url',
        input
      })
    ]} streaming={false} />)

    fireEvent.click(headerButton())

    expect(screen.getByText('Accessed website')).toBeInTheDocument()
    expect(screen.getByText('docs.example.com/guide')).toBeInTheDocument()
    expect(screen.queryByText(/token=secret/)).toBeNull()

    fireEvent.click(screen.getByText('Accessed website').closest('button')!)

    expect(screen.getByText(/token=secret/)).toBeInTheDocument()
  })

  it('shows built-in filesystem targets and search queries in collapsed rows', () => {
    render(<AgentTracePanel steps={[
      step({
        id: 'read',
        kind: 'tool',
        name: 'read_file',
        input: JSON.stringify({ file_path: 'outputs/report.md', offset: 0, limit: 100 })
      }),
      step({
        id: 'grep',
        kind: 'tool',
        name: 'grep',
        input: JSON.stringify({ pattern: 'citation', path: 'outputs' })
      }),
      step({
        id: 'web-search',
        kind: 'tool',
        name: 'web_search',
        input: JSON.stringify({ query: 'VLA harness latest research' })
      })
    ]} streaming={false} />)

    fireEvent.click(headerButton())

    expect(screen.getByText('outputs/report.md')).toBeInTheDocument()
    expect(screen.getByText('“citation” · outputs')).toBeInTheDocument()
    expect(screen.getByText('Searched the web')).toBeInTheDocument()
    expect(screen.getByText('“VLA harness latest research”')).toBeInTheDocument()
  })

  it('shows known academic research sites without restoring redacted inputs', () => {
    render(<AgentTracePanel steps={[
      step({
        id: 'arxiv',
        kind: 'tool',
        name: 'search_arxiv',
        input: null,
        output: 'Academic research data kept transient for this run.'
      }),
      step({
        id: 'citations',
        kind: 'tool',
        name: 'get_related_academic_papers',
        input: null,
        output: 'Academic research data kept transient for this run.'
      })
    ]} streaming={false} />)

    fireEvent.click(headerButton())

    expect(screen.getByText('arxiv.org')).toBeInTheDocument()
    expect(screen.getByText('semanticscholar.org')).toBeInTheDocument()
    expect(screen.queryByText(/query/i)).toBeNull()
  })

  it('labels OCR full-text reading separately from regular extraction', () => {
    render(<AgentTracePanel steps={[
      step({
        id: 'ocr-read',
        kind: 'tool',
        name: 'read_paper',
        input: JSON.stringify({ docId: 'doc-1', source: 'ocr', offset: 8000, limit: 8000 })
      }),
      step({
        id: 'ocr-prepare',
        kind: 'tool',
        name: 'prepare_paper_ocr'
      })
    ]} streaming={false} />)
    fireEvent.click(headerButton())
    expect(screen.getByText('Read OCR cache (chunk 2)')).toBeInTheDocument()
    expect(screen.getByText('Prepared balanced OCR cache')).toBeInTheDocument()
  })

  it('distinguishes an OCR approval wait and rejection from active OCR', () => {
    render(<AgentTracePanel steps={[
      step({
        id: 'ocr-approval',
        kind: 'tool',
        name: 'prepare_paper_ocr',
        status: 'interrupted'
      }),
      step({
        id: 'ocr-rejected',
        kind: 'tool',
        name: 'prepare_paper_ocr',
        status: 'cancelled'
      })
    ]} streaming={false} />)
    fireEvent.click(headerButton())

    expect(screen.getByText('OCR approval requested')).toBeInTheDocument()
    expect(screen.getByText('OCR was not run')).toBeInTheDocument()
    expect(screen.queryByText('Running balanced OCR…')).toBeNull()
  })

})
