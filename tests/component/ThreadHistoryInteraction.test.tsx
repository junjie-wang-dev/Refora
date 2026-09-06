import { useState } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ThreadHistory from '../../src/renderer/components/workspace/ThreadHistory'
import { useWorkspaceStore } from '../../src/renderer/store/workspaceStore'
import { initI18n } from '../../src/renderer/i18n'

initI18n('en')
const selectThread = vi.fn()
const renameThread = vi.fn()

function Harness() {
  const [open, setOpen] = useState(false)
  return <div data-testid="clipped-header" style={{ overflow: 'hidden', height: 30 }}>
    <ThreadHistory streaming={false} onExportThread={vi.fn()} menuOpen={open} onMenuOpenChange={setOpen} />
    <button>Outside</button>
  </div>
}

beforeEach(() => {
  vi.clearAllMocks()
  useWorkspaceStore.setState({
    threads: [{ id: 'thread-1', workspaceId: null, providerId: 'provider-1', agentProfileId: null, createdAt: 0, title: 'Paper discussion', headCheckpointId: null, agentStateVersion: 0 }],
    activeThreadId: 'thread-1',
    setActiveThreadId: selectThread,
    renameThread
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('opens outside the clipped panel header and selects a conversation inside the popup', () => {
  render(<Harness />)
  const trigger = screen.getByRole('button', { name: 'Thread history' })
  fireEvent.click(trigger)
  const popup = screen.getByRole('region', { name: 'Thread history' })
  expect(screen.getByTestId('clipped-header')).not.toContainElement(popup)
  expect(popup.parentElement).toBe(document.body)
  expect(trigger).toHaveAttribute('aria-expanded', 'true')
  expect(trigger).toHaveAttribute('aria-controls', popup.id)
  const thread = within(popup).getByRole('button', { name: 'Paper discussion' })
  fireEvent.mouseDown(thread)
  expect(popup).toBeInTheDocument()
  fireEvent.click(thread)
  expect(selectThread).toHaveBeenCalledWith('thread-1')
  expect(screen.queryByRole('region')).not.toBeInTheDocument()
  expect(trigger).toHaveAttribute('aria-expanded', 'false')
})

it('closes on Escape and returns focus to the history trigger', () => {
  render(<Harness />)
  const trigger = screen.getByRole('button', { name: 'Thread history' })
  fireEvent.click(trigger)
  const thread = screen.getByRole('button', { name: 'Paper discussion' })
  thread.focus()
  fireEvent.keyDown(thread, { key: 'Escape' })
  expect(screen.queryByRole('region')).not.toBeInTheDocument()
  expect(trigger).toHaveFocus()
})

it('dismisses on an outside click', () => {
  render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: 'Thread history' }))
  fireEvent.mouseDown(screen.getByRole('button', { name: 'Outside' }))
  expect(screen.queryByRole('region')).not.toBeInTheDocument()
})

it('cancels a rename without saving or closing the conversation menu', () => {
  render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: 'Thread history' }))
  fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
  const input = screen.getByRole('textbox')
  fireEvent.change(input, { target: { value: 'Unwanted title' } })
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(renameThread).not.toHaveBeenCalled()
  expect(screen.getByRole('region')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Paper discussion' })).toBeInTheDocument()
})

it('keeps the popup within the viewport when its anchor is near the right edge', () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ top: 30, bottom: 60, left: window.innerWidth - 30, right: window.innerWidth, width: 30, height: 30, x: 0, y: 30, toJSON: () => ({}) })
  render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: 'Thread history' }))
  const popup = screen.getByRole('region')
  expect(Number.parseFloat(popup.style.left) + Number.parseFloat(popup.style.width)).toBeLessThanOrEqual(window.innerWidth - 8)
  expect(Number.parseFloat(popup.style.top) + Number.parseFloat(popup.style.maxHeight)).toBeLessThanOrEqual(window.innerHeight - 12)
})
