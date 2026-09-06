import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

interface ActiveDialog {
  element: HTMLElement
  restore: () => void
}

const dialogs: ActiveDialog[] = []

function topDialog(includeDisconnected = false): ActiveDialog | undefined {
  let top: ActiveDialog | undefined
  for (const entry of dialogs) {
    if (!includeDisconnected && !entry.element.isConnected) continue
    if (!top || !entry.element.contains(top.element)) top = entry
  }
  return top
}

function canFocus(element: HTMLElement): boolean {
  if (!element.isConnected || element.matches(':disabled') || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false
  const style = window.getComputedStyle(element)
  return style.display !== 'none' && style.visibility !== 'hidden'
}

export function useModalDialog<T extends HTMLElement>(
  open: boolean,
  onClose: () => void
): RefObject<T | null> {
  const dialogRef = useRef<T>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (!open) return
    const dialog = dialogRef.current
    if (!dialog) return
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    let lastFocus: HTMLElement | null = null
    let recoveryFrame: number | undefined
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(canFocus)
    const entry: ActiveDialog = {
      element: dialog,
      restore: () => {
        if (topDialog() !== entry || dialog.contains(document.activeElement)) return
        const candidates = focusable()
        const target = lastFocus && canFocus(lastFocus) ? lastFocus : candidates.find((candidate) => candidate.hasAttribute('data-autofocus')) ?? candidates[0] ?? dialog
        target.focus({ preventScroll: true })
      }
    }
    dialogs.push(entry)
    const handleFocus = (event: FocusEvent) => {
      if (topDialog() !== entry) return
      if (event.target instanceof HTMLElement && dialog.contains(event.target)) {
        lastFocus = event.target
      } else {
        entry.restore()
      }
    }
    const handleWindowFocus = () => {
      entry.restore()
      if (recoveryFrame !== undefined) window.cancelAnimationFrame(recoveryFrame)
      recoveryFrame = window.requestAnimationFrame(entry.restore)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (topDialog() !== entry) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const candidates = focusable()
      if (candidates.length === 0) {
        event.preventDefault()
        dialog.focus()
        return
      }
      const first = candidates[0]
      const last = candidates[candidates.length - 1]
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('focusin', handleFocus)
    document.addEventListener('keydown', handleKeyDown)
    window.addEventListener('focus', handleWindowFocus)
    entry.restore()
    return () => {
      const wasTop = topDialog(true) === entry
      dialogs.splice(dialogs.indexOf(entry), 1)
      document.removeEventListener('focusin', handleFocus)
      document.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('focus', handleWindowFocus)
      if (recoveryFrame !== undefined) window.cancelAnimationFrame(recoveryFrame)
      const remaining = topDialog()
      if (!wasTop && remaining) return
      if (previousFocus && canFocus(previousFocus) && (!remaining || remaining.element.contains(previousFocus))) {
        previousFocus.focus({ preventScroll: true })
      } else {
        remaining?.restore()
      }
    }
  }, [open])

  return dialogRef
}
