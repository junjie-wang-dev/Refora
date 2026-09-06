import { createRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import MarkdownEditor, { type MarkdownEditorHandle } from '../../src/renderer/components/markdown/MarkdownEditor'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function setup(initial = '') {
  const editorRef = createRef<MarkdownEditorHandle>()
  function Wrapper() {
    const [value, setValue] = useState(initial)
    return <MarkdownEditor ref={editorRef} value={value} onChange={setValue} ariaLabel="Body" />
  }
  render(<Wrapper />)
  const textarea = screen.getByRole('textbox', { name: 'Body' }) as HTMLTextAreaElement
  const select = (start: number, end = start) => { textarea.focus(); textarea.setSelectionRange(start, end); fireEvent.select(textarea) }
  return { textarea, select, editorRef }
}

describe('MarkdownEditor', () => {
  it('formats selected text with shortcuts and supports undo and redo', () => {
    const { textarea, select } = setup('A finding')
    select(2, 9)
    fireEvent.keyDown(textarea, { key: 'b', metaKey: true })
    expect(textarea.value).toBe('A **finding**')
    expect(textarea.selectionStart).toBe(4)
    expect(textarea.selectionEnd).toBe(11)
    fireEvent.keyDown(textarea, { key: 'z', metaKey: true })
    expect(textarea.value).toBe('A finding')
    fireEvent.keyDown(textarea, { key: 'z', metaKey: true, shiftKey: true })
    expect(textarea.value).toBe('A **finding**')
  })

  it('reads operating-system selection changes before keyboard and toolbar formatting', () => {
    const { textarea } = setup('First item and second item')
    textarea.setSelectionRange(0, 10)
    fireEvent.keyDown(textarea, { key: 'b', metaKey: true })
    expect(textarea.value).toBe('**First item** and second item')
    textarea.setSelectionRange(19, 30)
    fireEvent.click(screen.getByRole('button', { name: 'markdown.editor.italic' }))
    expect(textarea.value).toBe('**First item** and *second item*')
  })

  it('reads the live selection when opening an insertion dialog', () => {
    const { textarea } = setup('Use a^2 here')
    textarea.setSelectionRange(4, 7)
    fireEvent.click(screen.getByRole('button', { name: 'markdown.editor.formula' }))
    expect(screen.getByRole('textbox', { name: 'markdown.editor.formulaSource' })).toHaveValue('a^2')
    fireEvent.click(screen.getByRole('button', { name: 'markdown.editor.insert' }))
    expect(textarea.value).toBe('Use \n\n$$\na^2\n$$\n\n here')
  })

  it('continues checked lists, exits empty items, and leaves IME Enter untouched', () => {
    const { textarea, select } = setup('- [x] done')
    select(textarea.value.length)
    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true })
    expect(textarea.value).toBe('- [x] done')
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(textarea.value).toBe('- [x] done\n- [ ] ')
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(textarea.value).toBe('- [x] done\n')
  })

  it('indents selected lines and reverses indentation', () => {
    const { textarea, select } = setup('- first\n- second')
    select(0, textarea.value.length)
    fireEvent.keyDown(textarea, { key: 'Tab' })
    expect(textarea.value).toBe('  - first\n  - second')
    fireEvent.keyDown(textarea, { key: 'Tab', shiftKey: true })
    expect(textarea.value).toBe('- first\n- second')
  })

  it('finds case-insensitively, navigates, and replaces literal text safely', async () => {
    const { textarea, editorRef } = setup('Alpha alpha ALPHA')
    act(() => editorRef.current?.openFind())
    fireEvent.change(screen.getByRole('textbox', { name: 'markdown.editor.findText' }), { target: { value: 'alpha' } })
    expect(screen.getByRole('status')).toHaveTextContent('1/3')
    expect(document.querySelectorAll('.markdown-editor-highlights mark')).toHaveLength(3)
    expect(textarea.selectionStart).toBe(0)
    expect(textarea.selectionEnd).toBe(5)
    fireEvent.click(screen.getByRole('button', { name: 'markdown.editor.next' }))
    expect(textarea.selectionStart).toBe(6)
    fireEvent.change(screen.getByRole('textbox', { name: 'markdown.editor.replaceText' }), { target: { value: '$&' } })
    fireEvent.click(screen.getByRole('button', { name: 'markdown.editor.replaceAll' }))
    expect(textarea.value).toBe('$& $& $&')
    expect(screen.getByRole('status')).toHaveTextContent('0/0')
  })

  it('edits an existing table without duplicating it and preserves alignment', () => {
    const { textarea, select } = setup('Intro\n\n| A | B |\n| :--- | ---: |\n| one | two |\n\nEnd')
    select(textarea.value.indexOf('one'))
    fireEvent.click(screen.getByRole('button', { name: 'markdown.editor.table' }))
    const cell = screen.getByRole('textbox', { name: 'markdown.editor.cell 2, 1' })
    expect(cell).toHaveValue('one')
    fireEvent.change(cell, { target: { value: 'three | four' } })
    fireEvent.click(screen.getByRole('button', { name: 'markdown.editor.insert' }))
    expect(textarea.value).toContain('| three \\| four | two |')
    expect(textarea.value).toContain('| :--- | ---: |')
    expect(textarea.value.match(/\| A \| B \|/g)).toHaveLength(1)
    expect(textarea.value).toContain('End')
  })

  it('previews and inserts a display formula at the selection', () => {
    const { textarea, select } = setup('Formula:')
    select(textarea.value.length)
    fireEvent.click(screen.getByRole('button', { name: 'markdown.editor.formula' }))
    expect(document.querySelector('.katex')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: 'markdown.editor.formulaSource' }), { target: { value: '\\frac{a}{b}' } })
    fireEvent.click(screen.getByRole('button', { name: 'markdown.editor.insert' }))
    expect(textarea.value).toBe('Formula:\n\n$$\n\\frac{a}{b}\n$$\n')
  })

  it('persists pasted images through the local resolver before inserting a managed reference', async () => {
    const resolveMedia = vi.spyOn(window.api.ai, 'resolveMedia').mockResolvedValue({ id: 'a'.repeat(64), url: 'refora-asset://media/test', kind: 'image', fileName: 'figure.png', mimeType: 'image/png', byteLength: 3 })
    const { textarea } = setup('Before ')
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    const file = new File(['png'], 'figure.png', { type: 'image/png' })
    fireEvent.paste(textarea, { clipboardData: { items: [{ kind: 'file', type: file.type, getAsFile: () => file }] } })
    await waitFor(() => expect(textarea.value).toBe(`Before ![figure](refora-asset://media/${'a'.repeat(64)})`))
    expect(resolveMedia).toHaveBeenCalledWith({ source: { type: 'inline', dataUrl: 'data:image/png;base64,cG5n' }, kind: 'image', fileName: 'figure.png' })
  })

  it('keeps the insertion point captured when the image picker opens', async () => {
    vi.spyOn(window.api.ai, 'resolveMedia').mockResolvedValue({ id: 'b'.repeat(64), url: 'refora-asset://media/test', kind: 'image', fileName: 'figure.png', mimeType: 'image/png', byteLength: 3 })
    const { textarea } = setup('Start End')
    textarea.setSelectionRange(6, 6)
    fireEvent.click(screen.getByRole('button', { name: 'markdown.editor.image' }))
    textarea.setSelectionRange(0, 0)
    const file = new File(['png'], 'figure.png', { type: 'image/png' })
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [file] } })
    await waitFor(() => expect(textarea.value).toBe(`Start ![figure](refora-asset://media/${'b'.repeat(64)})End`))
  })

  it('preserves text and reports failed image storage', async () => {
    vi.spyOn(window.api.ai, 'resolveMedia').mockRejectedValue(new Error('disk full'))
    const { textarea } = setup('Keep my draft')
    const file = new File(['png'], 'figure.png', { type: 'image/png' })
    fireEvent.paste(textarea, { clipboardData: { items: [{ kind: 'file', type: file.type, getAsFile: () => file }] } })
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('markdown.editor.imageFailed'))
    expect(textarea.value).toBe('Keep my draft')
  })
})
