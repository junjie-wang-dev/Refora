import { describe, expect, it, vi } from 'vitest'
import { preserveNativeEditContextMenu } from '../../src/renderer/utils/editContextMenu'

describe('input context-menu routing', () => {
  it.each(['input', 'textarea'])('preserves native editing and suppresses ancestor card menus for %s', (tag) => {
    const card = document.createElement('div')
    const input = document.createElement(tag)
    card.append(input)
    document.body.append(card)
    const menu = vi.fn((event: Event) => event.preventDefault())
    card.addEventListener('contextmenu', menu)
    window.addEventListener('contextmenu', preserveNativeEditContextMenu, true)
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    input.dispatchEvent(event)
    expect(menu).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
    window.removeEventListener('contextmenu', preserveNativeEditContextMenu, true)
    card.remove()
  })

  it('keeps card context menus available outside inputs', () => {
    const card = document.createElement('div')
    const event = new MouseEvent('contextmenu', { bubbles: true })
    Object.defineProperty(event, 'target', { value: card })
    const stop = vi.spyOn(event, 'stopPropagation')
    preserveNativeEditContextMenu(event)
    expect(stop).not.toHaveBeenCalled()
  })

  it.each(['readOnly', 'disabled'] as const)('preserves the card menu when its textarea is %s', (state) => {
    const card = document.createElement('div')
    const input = document.createElement('textarea')
    input[state] = true
    card.append(input)
    document.body.append(card)
    const menu = vi.fn((event: Event) => event.preventDefault())
    card.addEventListener('contextmenu', menu)
    window.addEventListener('contextmenu', preserveNativeEditContextMenu, true)
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    input.dispatchEvent(event)
    expect(menu).toHaveBeenCalledOnce()
    expect(event.defaultPrevented).toBe(true)
    window.removeEventListener('contextmenu', preserveNativeEditContextMenu, true)
    card.remove()
  })
})
