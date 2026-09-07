import { describe, expect, it } from 'vitest'
import { resolveAgentToolCall } from '../../src/shared/agent-tools'
import { AGENT_APPLICATION_ACTIONS } from '../../src/shared/server-contract'

describe('compact application tool calls', () => {
  it('resolves every generated action and preserves nested arguments', () => {
    for (const [name, actions] of Object.entries(AGENT_APPLICATION_ACTIONS)) {
      for (const [action, operation] of Object.entries(actions)) {
        const parameters = { workspaceId: 'workspace', docIds: ['paper'] }
        expect(resolveAgentToolCall(name, { action, parameters })).toEqual({ name: operation, args: parameters })
      }
    }
  })

  it('keeps historical calls readable and does not resolve prototype properties', () => {
    expect(resolveAgentToolCall('refora.read_paper', { docId: 'paper' })).toEqual({ name: 'read_paper', args: { docId: 'paper' } })
    expect(resolveAgentToolCall('refora_workspace', { action: 'constructor' }).name).toBe('refora_workspace')
    expect(resolveAgentToolCall('__proto__', { action: 'toString' }).name).toBe('__proto__')
  })
})
