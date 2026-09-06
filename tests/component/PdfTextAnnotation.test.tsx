import { useRef, useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
    controlsRef: { current: null },
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
  const controlsRef = useRef<HTMLDivElement>(null)
  const [annotation, setAnnotation] = useState(initialAnnotation)
  const [editing, setEditing] = useState(initialEditing)
  const [selected, setSelected] = useState(initialEditing)
  return (
    <div data-reader="true">
      <div ref={controlsRef} data-test-text-controls onPointerDown={(event) => event.preventDefault()}>
        <button onClick={() => setAnnotation((current) => ({ ...current, fontSize: (current.fontSize ?? 14) + 2 }))}>Increase font</button>
        <button onClick={() => setAnnotation((current) => ({ ...current, color: '#56ccf2' }))}>Change color</button>
        <button onClick={() => editing ? setEditing(false) : setEditing(true)}>{editing ? 'Done' : 'Edit'}</button>
      </div>
      <PdfTextAnnotation
        {...props()}
        annotation={annotation}
        controlsRef={controlsRef}
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
    expect(screen.getByRole('button', { name: 'Done' })).toBeVisible()
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
    await user.click(screen.getByRole('button', { name: 'Increase font' }))
    expect(textarea).toHaveFocus()
    expect(textarea.selectionStart).toBe(caret)
    expect(textarea).toHaveStyle({ fontSize: '16px' })
    await user.click(screen.getByRole('button', { name: 'Change color' }))
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

  it.each(['blur', 'outside', 'keyboard'] as const)('commits the current composed DOM text before finishing on %s', (completion) => {
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
    else { fireEvent.compositionEnd(textarea); fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true }) }
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
    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(onFinish).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('textbox', { name: 'pdfReader.tools.text' })).toHaveAttribute('readonly')
    expect(screen.getByRole('button', { name: 'Edit' })).toBeVisible()
  })

  it('allows focus in top formatting controls and finishes when focus leaves those controls', () => {
    const controls = document.createElement('div')
    const increase = document.createElement('button')
    controls.append(increase)
    document.body.append(controls)
    const callbacks = props({ selected: true, editing: true, controlsRef: { current: controls } })
    const view = render(<PdfTextAnnotation {...callbacks} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.pointerDown(increase)
    fireEvent.blur(textarea, { relatedTarget: increase })
    expect(callbacks.onFinishEditing).not.toHaveBeenCalled()
    fireEvent.blur(increase, { relatedTarget: document.body })
    expect(callbacks.onFinishEditing).toHaveBeenCalledOnce()
    view.unmount()
    controls.remove()
  })

  it('keeps formatting controls out of reading mode and closes when the PDF is hidden or unmounted', async () => {
    const callbacks = props({ selected: false })
    const view = render(<PdfTextAnnotation {...callbacks} />)
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
    view.rerender(<PdfTextAnnotation {...callbacks} selected editing />)
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
    view.rerender(<PdfTextAnnotation {...callbacks} selected editing active={false} />)
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
    expect(callbacks.onFinishEditing).toHaveBeenCalledOnce()
    view.rerender(<PdfTextAnnotation {...callbacks} selected editing />)
    view.unmount()
    await act(async () => {})
    expect(callbacks.onFinishEditing).toHaveBeenCalledTimes(2)
  })

  it('keeps rotated geometry stable on entry without creating floating controls', () => {
    const callbacks = props({ annotation: { ...textAnnotation, fontSize: 8 }, selected: true, rotation: 90 })
    const view = render(<PdfTextAnnotation {...callbacks} />)
    const textarea = screen.getByRole('textbox')
    const style = textarea.getAttribute('style')
    expect(textarea).toHaveStyle({ transform: 'translateX(40px) rotate(90deg)' })
    view.rerender(<PdfTextAnnotation {...callbacks} editing />)
    expect(textarea.getAttribute('style')).toBe(style)
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
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

  it('leaves selection framing to the shared annotation layer', () => {
    render(<PdfTextAnnotation {...props({ selected: true })} />)
    const textarea = screen.getByRole('textbox')
    expect(textarea).toHaveAttribute('data-text-selected', 'true')
    expect(textarea).toHaveClass('outline-none')
    expect(textarea).not.toHaveClass('outline-accent')
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
  })
})
