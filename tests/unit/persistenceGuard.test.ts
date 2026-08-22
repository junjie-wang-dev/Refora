import { describe, expect, it, vi } from 'vitest'
import { runPersistenceGuard } from '../../src/main/services/persistenceGuard'

describe('persistence guard', () => {
  it('retries until persistence succeeds', async () => {
    const persist = vi.fn()
      .mockRejectedValueOnce(new Error('failed'))
      .mockResolvedValueOnce(undefined)
    const resolveFailure = vi.fn().mockResolvedValue('retry')

    await expect(runPersistenceGuard({ persist, resolveFailure })).resolves.toBe('saved')
    expect(persist).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['cancel', 'cancelled'],
    ['discard', 'discarded']
  ] as const)('returns %s decisions without another write', async (action, result) => {
    const persist = vi.fn().mockRejectedValue(new Error('failed'))

    await expect(runPersistenceGuard({
      persist,
      resolveFailure: vi.fn().mockResolvedValue(action)
    })).resolves.toBe(result)
    expect(persist).toHaveBeenCalledOnce()
  })
})
