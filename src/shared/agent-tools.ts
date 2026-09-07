import { AGENT_APPLICATION_ACTIONS } from './server-contract'

export function resolveAgentToolCall(name: string, args: Record<string, unknown>): {
  name: string
  args: Record<string, unknown>
} {
  const normalizedName = name.replace(/^refora\./, '')
  const groups: Record<string, Record<string, string>> = AGENT_APPLICATION_ACTIONS
  const group = Object.hasOwn(groups, normalizedName) ? groups[normalizedName] : undefined
  const operation = group && typeof args.action === 'string' && Object.hasOwn(group, args.action) ? group[args.action] : undefined
  if (!operation) return { name: normalizedName, args }
  const parameters = args.parameters
  return {
    name: operation,
    args: parameters && typeof parameters === 'object' && !Array.isArray(parameters)
      ? parameters as Record<string, unknown> : {}
  }
}
