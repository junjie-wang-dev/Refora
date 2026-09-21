import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import WorkspaceReaderTabs, { type WorkspaceReaderTab } from '../../src/renderer/components/workspace/WorkspaceReaderTabs'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const makeTabs = (): WorkspaceReaderTab[] => ['A', 'B', 'C'].map((id) => ({
  id, title: id, kind: 'workspace', active: id === 'B', onSelect: vi.fn(), onClose: vi.fn()
}))
const titles = () => screen.getAllByRole('tab').map((tab) => tab.textContent)
const move = (from: string, to: string) => {
  const source = screen.getByRole('tab', { name: from })
  source.setPointerCapture = vi.fn()
  source.hasPointerCapture = vi.fn(() => false)
  const elements = screen.getAllByRole('tab').map((tab) => tab.parentElement!)
  for (const [index, element] of elements.entries()) {
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({ left: index * 100, right: (index + 1) * 100, top: 0, bottom: 36, width: 100, height: 36, x: index * 100, y: 0, toJSON: () => ({}) })
  }
  const startX = elements.indexOf(source.parentElement!) * 100 + 50
  const targetIndex = elements.indexOf(screen.getByRole('tab', { name: to }).parentElement!)
  const sourceIndex = elements.indexOf(source.parentElement!)
  const endX = (targetIndex - (sourceIndex < targetIndex ? 1 : 0)) * 100 + 50
  fireEvent.pointerDown(source, { button: 0, pointerId: 1, clientX: startX, clientY: 12 })
  fireEvent.pointerMove(source, { pointerId: 1, clientX: endX, clientY: 12 })
  fireEvent.pointerUp(source, { pointerId: 1, clientX: endX, clientY: 12 })
  fireEvent.click(source)
  vi.restoreAllMocks()
}

describe('WorkspaceReaderTabs', () => {
  it('reorders in both directions without selecting or closing a tab', () => {
    const tabs = makeTabs()
    render(<WorkspaceReaderTabs tabs={tabs} fullscreen={false} onToggleFullscreen={vi.fn()} />)
    move('C', 'A')
    expect(titles()).toEqual(['C', 'A', 'B'])
    move('C', 'B')
    expect(titles()).toEqual(['A', 'C', 'B'])
    expect(screen.getByRole('tab', { name: 'B' })).toHaveAttribute('aria-selected', 'true')
    for (const tab of tabs) {
      expect(tab.onSelect).not.toHaveBeenCalled()
      expect(tab.onClose).not.toHaveBeenCalled()
    }
  })

  it('keeps order across updates and appends reopened tabs', () => {
    const tabs = makeTabs()
    const { rerender } = render(<WorkspaceReaderTabs tabs={tabs} fullscreen={false} onToggleFullscreen={vi.fn()} />)
    move('C', 'A')
    rerender(<WorkspaceReaderTabs tabs={tabs.slice(1)} fullscreen onToggleFullscreen={vi.fn()} />)
    expect(titles()).toEqual(['C', 'B'])
    rerender(<WorkspaceReaderTabs tabs={tabs} fullscreen onToggleFullscreen={vi.fn()} />)
    expect(titles()).toEqual(['C', 'B', 'A'])
    fireEvent.click(screen.getByRole('tab', { name: 'A' }))
    expect(tabs[0].onSelect).toHaveBeenCalledOnce()
  })

  it('cancels dragging without changing order', () => {
    render(<WorkspaceReaderTabs tabs={makeTabs()} fullscreen={false} onToggleFullscreen={vi.fn()} />)
    const source = screen.getByRole('tab', { name: 'C' })
    source.setPointerCapture = vi.fn()
    fireEvent.pointerDown(source, { button: 0, pointerId: 1 })
    fireEvent.pointerCancel(source)
    expect(titles()).toEqual(['A', 'B', 'C'])
  })
})
