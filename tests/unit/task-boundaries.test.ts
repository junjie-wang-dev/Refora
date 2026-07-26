import { describe, expect, it, vi } from 'vitest'
import { runMenuAction } from '../../src/main/services/menuAction'

describe('menu action boundary', () => {
  it('reports synchronous and asynchronous action failures without rejecting', async () => {
    const onError = vi.fn()

    await expect(runMenuAction(() => { throw new Error('sync') }, onError)).resolves.toBeUndefined()
    await expect(runMenuAction(async () => { throw new Error('async') }, onError)).resolves.toBeUndefined()

    expect(onError).toHaveBeenNthCalledWith(1, expect.objectContaining({ message: 'sync' }))
    expect(onError).toHaveBeenNthCalledWith(2, expect.objectContaining({ message: 'async' }))
  })
})
