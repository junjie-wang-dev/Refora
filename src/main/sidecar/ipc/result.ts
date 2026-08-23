import type { Result } from '../../../shared/ipc-types'

export function toIpcError(error: unknown): Result<never> {
  const message = error instanceof Error ? error.message : String(error)
  const code =
    error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : 'internal_error'
  return { ok: false, error: { code, message } }
}

export async function resultify<T>(request: () => T | Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await request() }
  } catch (error) {
    return toIpcError(error)
  }
}
