import { describe, expect, it, vi } from 'vitest'
import { handoffSecondInstance } from '../../src/main/services/instanceHandoff'

describe('single instance handoff', () => {
  it('consumes a deep link and restores and focuses the primary window', () => {
    const handleDeepLink = vi.fn((value: string) => value.startsWith('refora://'))
    const window = {
      isDestroyed: vi.fn(() => false),
      isMinimized: vi.fn(() => true),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn()
    }

    handoffSecondInstance(
      ['/Applications/Refora.app/Contents/MacOS/Refora', '--flag', 'refora://auth/confirmed?nonce=test'],
      handleDeepLink,
      () => window
    )

    expect(handleDeepLink).toHaveBeenNthCalledWith(1, '--flag')
    expect(handleDeepLink).toHaveBeenNthCalledWith(2, 'refora://auth/confirmed?nonce=test')
    expect(window.restore).toHaveBeenCalledOnce()
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
  })

  it('does not interact with a destroyed primary window', () => {
    const window = {
      isDestroyed: vi.fn(() => true),
      isMinimized: vi.fn(() => true),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn()
    }

    handoffSecondInstance(['/Applications/Refora'], vi.fn(() => false), () => window)

    expect(window.restore).not.toHaveBeenCalled()
    expect(window.show).not.toHaveBeenCalled()
    expect(window.focus).not.toHaveBeenCalled()
  })
})
