import { useState } from 'react'
import { createPortal } from 'react-dom'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useModalDialog } from '../../src/renderer/hooks/useModalDialog'

function Dialog({ name, onClose, nested = false }: { name: string; onClose: () => void; nested?: boolean }) {
  const ref = useModalDialog<HTMLDivElement>(true, onClose)
  const [childOpen, setChildOpen] = useState(false)
  return createPortal(<div ref={ref} role="dialog" aria-modal="true" aria-label={name} tabIndex={-1}>
    <button type="button">First {name}</button>
    <button type="button">Last {name}</button>
    {nested && <button type="button" onClick={() => setChildOpen(true)}>Open child</button>}
    {childOpen && <Dialog name="child" onClose={() => setChildOpen(false)} />}
  </div>, document.body)
}

function PreferredDialog() {
  const ref = useModalDialog<HTMLDivElement>(true, vi.fn())
  return <div ref={ref} role="dialog" aria-modal="true" tabIndex={-1}><button type="button">Close</button><input data-autofocus aria-label="Formula" /></div>
}

function Harness() {
  const [open, setOpen] = useState(false)
  return <><button type="button" onClick={() => setOpen(true)}>Open dialog</button><button type="button">Outside</button>{open && <Dialog name="parent" nested onClose={() => setOpen(false)} />}</>
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('modal focus recovery', () => {
  it('focuses the preferred input before earlier toolbar controls', () => {
    render(<PreferredDialog />)
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Formula' }))
  })

  it('recovers the previous dialog control when a native window returns focus to the body', () => {
    render(<Dialog name="export" onClose={vi.fn()} />)
    const last = screen.getByRole('button', { name: 'Last export' })
    last.focus()
    last.blur()
    expect(document.activeElement).toBe(document.body)
    fireEvent.focus(window)
    expect(document.activeElement).toBe(last)
  })

  it('returns escaping focus to the active dialog and retains Tab wrapping', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Open dialog' }))
    const dialog = screen.getByRole('dialog', { name: 'parent' })
    const first = within(dialog).getByRole('button', { name: 'First parent' })
    const last = within(dialog).getByRole('button', { name: 'Open child' })
    expect(document.activeElement).toBe(first)
    screen.getByRole('button', { name: 'Outside' }).focus()
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(document.activeElement).toBe(first)
  })

  it('protects nested dialogs from parent recovery and returns focus after closing each level', () => {
    render(<Harness />)
    const opener = screen.getByRole('button', { name: 'Open dialog' })
    opener.focus()
    fireEvent.click(opener)
    const childOpener = screen.getByRole('button', { name: 'Open child' })
    childOpener.focus()
    fireEvent.click(childOpener)
    const childLast = screen.getByRole('button', { name: 'Last child' })
    childLast.focus()
    childLast.blur()
    fireEvent.focus(window)
    expect(document.activeElement).toBe(childLast)
    fireEvent.keyDown(childLast, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'child' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'parent' })).toBeInTheDocument()
    expect(document.activeElement).toBe(childOpener)
    fireEvent.keyDown(childOpener, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('handles Escape after native focus loss and skips unavailable controls during recovery', () => {
    const close = vi.fn()
    render(<Dialog name="export" onClose={close} />)
    const first = screen.getByRole('button', { name: 'First export' })
    const last = screen.getByRole('button', { name: 'Last export' })
    last.focus()
    last.blur()
    last.setAttribute('disabled', '')
    fireEvent.focus(window)
    expect(document.activeElement).toBe(first)
    first.blur()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(close).toHaveBeenCalledOnce()
  })
})
