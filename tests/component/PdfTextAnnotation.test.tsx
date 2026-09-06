import { useRef, useState, type RefObject } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PdfTextAnnotation, { type PdfTextAnnotationProps } from '../../src/renderer/components/PdfTextAnnotation'
import type { PdfAnnotation } from '../../src/renderer/store/pdfReaderStore'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

const textAnnotation: PdfAnnotation = {
  id: 'text', kind: 'text', page: 1, text: 'A useful observation', comment: '',
  color: '#eb5757', fontSize: 14, point: { x: 0.2, y: 0.3 },
  size: { width: 0.4, height: 0.05 }, createdAt: 0
}

function bounds(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left, top, right: left + width, bottom: top + height, x: left, y: top, width, height,
    toJSON: () => ({})
  }
}

function props(overrides: Partial<PdfTextAnnotationProps> = {}): PdfTextAnnotationProps {
  return {
    annotation: textAnnotation,
    scale: 1,
    rotation: 0,
    baseSize: { width: 600, height: 800 },
    rect: { x: 0.2, y: 0.3, width: 0.4, height: 0.05 },
    selected: false,
    editing: false,
    active: true,
    scrollRootRef: { current: null },
    interactive: true,
    erasing: false,
    onSelect: vi.fn(),
    onStartEditing: vi.fn(),
    onFinishEditing: vi.fn(),
    onDragStart: vi.fn(),
    onUpdate: vi.fn(),
    onDelete: vi.fn(),
    ...overrides
  }
}

function EditorHarness({
  initialAnnotation = textAnnotation,
  initialEditing = true,
  onFinish = vi.fn()
}: {
  initialAnnotation?: PdfAnnotation
  initialEditing?: boolean
  onFinish?: () => void
}) {
  const scrollRootRef = useRef<HTMLDivElement>(null)
  const [annotation, setAnnotation] = useState(initialAnnotation)
  const [editing, setEditing] = useState(initialEditing)
  const [selected, setSelected] = useState(initialEditing)
  return (
    <div ref={scrollRootRef} data-reader="true">
      <PdfTextAnnotation
        {...props()}
        annotation={annotation}
        scrollRootRef={scrollRootRef}
        selected={selected}
        editing={editing}
        onSelect={() => setSelected(true)}
        onStartEditing={() => { setSelected(true); setEditing(true) }}
        onFinishEditing={() => { setEditing(false); onFinish() }}
        onUpdate={(patch) => setAnnotation((current) => ({ ...current, ...patch }))}
      />
      <input aria-label="Other input" />
    </div>
  )
}

describe('PdfTextAnnotation editing experience', () => {
  let anchor: DOMRect
  let reader: DOMRect

  beforeEach(() => {
    anchor = bounds(150, 260, 240, 40)
    reader = bounds(40, 100, 700, 600)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this instanceof HTMLTextAreaElement) return anchor
      if (this.dataset.textAnnotationToolbar) return bounds(0, 0, 320, 42)
      return reader
    })
  })

  afterEach(async () => {
    cleanup()
    await act(async () => {})
    vi.restoreAllMocks()
  })

  it('keeps click selection and drag separate from explicit editing entry points', () => {
    const callbacks = props()
    render(<PdfTextAnnotation {...callbacks} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.pointerDown(textarea, { pointerId: 1, button: 0 })
    fireEvent.click(textarea)
    expect(callbacks.onDragStart).toHaveBeenCalledOnce()
    expect(callbacks.onSelect).toHaveBeenCalledOnce()
    expect(callbacks.onStartEditing).not.toHaveBeenCalled()
    expect(textarea).toHaveAttribute('readonly')
    fireEvent.doubleClick(textarea)
    fireEvent.keyDown(textarea, { key: 'Enter' })
    fireEvent.keyDown(textarea, { key: 'F2' })
    expect(callbacks.onStartEditing).toHaveBeenCalledTimes(3)
  })

  it('uses the same textarea, geometry and controls for creation and repeat editing', async () => {
    const user = userEvent.setup()
    render(<EditorHarness initialAnnotation={{ ...textAnnotation, text: '' }} />)
    const textarea = screen.getByRole('textbox', { name: 'pdfReader.tools.text' }) as HTMLTextAreaElement
    const initialClass = textarea.className
    const initialStyle = textarea.getAttribute('style')
    expect(textarea).toHaveFocus()
    await user.type(textarea, 'First line{Enter}Second line')
    expect(textarea.value).toBe('First line\nSecond line')
    await user.keyboard('{Escape}')
    expect(textarea).toHaveAttribute('readonly')
    fireEvent.doubleClick(textarea)
    expect(screen.getByRole('textbox', { name: 'pdfReader.tools.text' })).toBe(textarea)
    expect(textarea).not.toHaveAttribute('readonly')
    expect(textarea).toHaveFocus()
    expect(textarea.className).toBe(initialClass)
    expect(textarea.getAttribute('style')).toBe(initialStyle)
    expect(textarea.selectionStart).toBe(textarea.value.length)
    expect(screen.getByRole('button', { name: 'pdfReader.finishEditingText' })).toBeVisible()
    expect(screen.queryByText('pdfReader.saveStatus.saved')).not.toBeInTheDocument()
  })

  it('preserves caret and focus through typing, color and font changes and parent rerenders', async () => {
    const user = userEvent.setup()
    const view = render(<EditorHarness />)
    const textarea = screen.getByRole('textbox', { name: 'pdfReader.tools.text' }) as HTMLTextAreaElement
    textarea.setSelectionRange(2, 2)
    await user.keyboard('new ')
    const caret = textarea.selectionStart
    expect(caret).toBe(6)
    await user.click(screen.getByRole('button', { name: 'pdfReader.increaseFontSize' }))
    expect(textarea).toHaveFocus()
    expect(textarea.selectionStart).toBe(caret)
    expect(textarea).toHaveStyle({ fontSize: '16px' })
    await user.click(screen.getByRole('button', { name: 'pdfReader.annotationColor #56ccf2' }))
    expect(textarea).toHaveFocus()
    expect(textarea.selectionStart).toBe(caret)
    expect(textarea).toHaveStyle({ color: '#56ccf2' })
    view.rerender(<EditorHarness />)
    expect(textarea).toHaveFocus()
    expect(textarea.selectionStart).toBe(caret)
    await user.keyboard('continued ')
    expect(textarea.value).toContain('A new continued useful observation')
  })

  it('keeps composing Enter and Escape inside the editor, and finishes with Cmd+Enter', () => {
    const onFinish = vi.fn()
    render(<EditorHarness onFinish={onFinish} />)
    const textarea = screen.getByRole('textbox', { name: 'pdfReader.tools.text' })
    fireEvent.compositionStart(textarea)
    fireEvent.keyDown(textarea, { key: 'Escape' })
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true })
    expect(onFinish).not.toHaveBeenCalled()
    fireEvent.compositionEnd(textarea)
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(onFinish).not.toHaveBeenCalled()
    fireEvent.keyDown(textarea, { key: 'Escape', isComposing: true })
    expect(onFinish).not.toHaveBeenCalled()
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true })
    expect(onFinish).toHaveBeenCalledOnce()
    expect(textarea).toHaveAttribute('readonly')
  })

  it.each(['blur', 'outside', 'done'] as const)('commits the current composed DOM text before finishing on %s', (completion) => {
    const events: string[] = []
    const callbacks = props({
      editing: true,
      selected: true,
      onUpdate: vi.fn(),
      onFinishEditing: () => events.push('finish')
    })
    const view = render(<PdfTextAnnotation {...callbacks} />)
    const latestUpdate = vi.fn((patch: { text?: string }) => events.push(`text:${patch.text}`))
    view.rerender(<PdfTextAnnotation {...callbacks} onUpdate={latestUpdate} />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.compositionStart(textarea)
    textarea.value = '输入法最终内容'
    if (completion === 'blur') fireEvent.blur(textarea, { relatedTarget: document.body })
    else if (completion === 'outside') fireEvent.pointerDown(document.body)
    else fireEvent.click(screen.getByRole('button', { name: 'pdfReader.finishEditingText' }))
    expect(events).toEqual(['text:输入法最终内容', 'finish'])
    expect(latestUpdate).toHaveBeenCalledOnce()
    expect(callbacks.onUpdate).not.toHaveBeenCalled()
  })

  it('finishes once on outside pointer or focus changes without taking focus back', async () => {
    const user = userEvent.setup()
    const onFinish = vi.fn()
    render(<EditorHarness onFinish={onFinish} />)
    const outside = screen.getByRole('textbox', { name: 'Other input' })
    await user.click(outside)
    expect(outside).toHaveFocus()
    expect(onFinish).toHaveBeenCalledOnce()
    fireEvent.doubleClick(screen.getByRole('textbox', { name: 'pdfReader.tools.text' }))
    await user.click(screen.getByRole('button', { name: 'pdfReader.finishEditingText' }))
    expect(onFinish).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('textbox', { name: 'pdfReader.tools.text' })).not.toHaveFocus()
    expect(screen.getByRole('button', { name: 'pdfReader.editText' })).toBeVisible()
  })

  it('allows keyboard focus in formatting controls before finishing when focus leaves', () => {
    const callbacks = props({ selected: true, editing: true })
    render(<PdfTextAnnotation {...callbacks} />)
    const textarea = screen.getByRole('textbox')
    const increase = screen.getByRole('button', { name: 'pdfReader.increaseFontSize' })
    fireEvent.blur(textarea, { relatedTarget: increase })
    expect(callbacks.onFinishEditing).not.toHaveBeenCalled()
    fireEvent.blur(increase, { relatedTarget: document.body })
    expect(callbacks.onFinishEditing).toHaveBeenCalledOnce()
  })

  it('clamps the floating toolbar to reader edges and follows scrolling and zoom', () => {
    const root = document.createElement('div')
    document.body.append(root)
    const scrollRootRef: RefObject<HTMLDivElement | null> = { current: root }
    anchor = bounds(680, 106, 60, 40)
    const view = render(<PdfTextAnnotation {...props({ selected: true, scrollRootRef })} />)
    const toolbar = screen.getByRole('toolbar')
    expect(toolbar).toHaveStyle({ left: '412px', top: '154px', maxWidth: '684px' })
    anchor = bounds(150, 600, 240, 40)
    fireEvent.scroll(root)
    expect(toolbar).toHaveStyle({ left: '150px', top: '550px' })
    anchor = bounds(150, 200, 480, 80)
    view.rerender(<PdfTextAnnotation {...props({ selected: true, scrollRootRef, scale: 2 })} />)
    expect(toolbar).toHaveStyle({ top: '150px' })
    expect(screen.getByRole('textbox')).toHaveStyle({ width: '480px', height: '80px' })
    anchor = bounds(150, -100, 480, 80)
    fireEvent.scroll(root)
    expect(toolbar).not.toBeVisible()
    root.remove()
  })

  it('keeps formatting controls out of reading mode and closes when the PDF is hidden or unmounted', async () => {
    const callbacks = props({ selected: false })
    const view = render(<PdfTextAnnotation {...callbacks} />)
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
    view.rerender(<PdfTextAnnotation {...callbacks} selected editing />)
    expect(screen.getByRole('toolbar')).toBeVisible()
    view.rerender(<PdfTextAnnotation {...callbacks} selected editing active={false} />)
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
    expect(callbacks.onFinishEditing).toHaveBeenCalledOnce()
    view.rerender(<PdfTextAnnotation {...callbacks} selected editing />)
    view.unmount()
    await act(async () => {})
    expect(callbacks.onFinishEditing).toHaveBeenCalledTimes(2)
  })

  it('keeps rotated geometry stable on entry and bounds font size without changing edit mode', async () => {
    const user = userEvent.setup()
    const callbacks = props({ annotation: { ...textAnnotation, fontSize: 8 }, selected: true, rotation: 90 })
    const view = render(<PdfTextAnnotation {...callbacks} />)
    const textarea = screen.getByRole('textbox')
    const style = textarea.getAttribute('style')
    expect(textarea).toHaveStyle({ transform: 'translateX(40px) rotate(90deg)' })
    expect(screen.getByRole('button', { name: 'pdfReader.decreaseFontSize' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'pdfReader.increaseFontSize' }))
    expect(callbacks.onUpdate).toHaveBeenLastCalledWith({ fontSize: 10 })
    expect(callbacks.onStartEditing).not.toHaveBeenCalled()
    view.rerender(<PdfTextAnnotation {...callbacks} editing />)
    expect(textarea.getAttribute('style')).toBe(style)
    view.rerender(<PdfTextAnnotation {...callbacks} annotation={{ ...textAnnotation, fontSize: 72 }} editing />)
    expect(screen.getByRole('button', { name: 'pdfReader.increaseFontSize' })).toBeDisabled()
  })

  it('erases text without opening an editor or its formatting controls', () => {
    const callbacks = props({ erasing: true, selected: true })
    render(<PdfTextAnnotation {...callbacks} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.pointerDown(textarea, { pointerId: 1, button: 0 })
    fireEvent.click(textarea)
    fireEvent.doubleClick(textarea)
    expect(callbacks.onDelete).toHaveBeenCalledOnce()
    expect(callbacks.onDragStart).not.toHaveBeenCalled()
    expect(callbacks.onStartEditing).not.toHaveBeenCalled()
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
  })

  it('preserves selected text outlines in a multi-selection without duplicating toolbars', () => {
    render(<PdfTextAnnotation {...props({ selected: true, showControls: false })} />)
    const textarea = screen.getByRole('textbox')
    expect(textarea).toHaveAttribute('data-text-selected', 'true')
    expect(textarea).toHaveClass('outline', 'outline-accent')
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
  })
})
