import { createRef, useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import LatexSourceEditor, { type LatexSourceHandle } from '../../src/renderer/components/latex/LatexSourceEditor'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(cleanup)

function setup(initial: string) {
  const handle = createRef<LatexSourceHandle>()
  const position = vi.fn()
  function Editor() {
    const [value, setValue] = useState(initial)
    return <LatexSourceEditor ref={handle} value={value} onChange={setValue} onPositionChange={position} />
  }
  render(<Editor />)
  return { handle, position, input: screen.getByLabelText<HTMLTextAreaElement>('latex.source') }
}

describe('LaTeX source navigation and insertion', () => {
  it('preserves text selected by search when inserting a workspace figure', async () => {
    const { input, handle } = setup('\\begin{document}\nLocal source.\n\\end{document}\n')
    fireEvent.keyDown(input, { key: 'f', metaKey: true })
    const search = screen.getByRole('textbox', { name: 'latex.find' })
    fireEvent.change(search, { target: { value: 'Local' } })
    fireEvent.keyDown(search, { key: 'Enter' })
    fireEvent.keyDown(search, { key: 'Escape' })
    act(() => handle.current!.insert('FIGURE\n'))
    await waitFor(() => expect(input).toHaveValue('\\begin{document}\nLocal source.\nFIGURE\n\\end{document}\n'))
  })
  it('starts with the first match and keeps Enter navigation in the search field', async () => {
    const { input } = setup('alpha beta alpha')
    fireEvent.keyDown(input, { key: 'f', metaKey: true })
    const search = screen.getByRole('textbox', { name: 'latex.find' })
    await waitFor(() => expect(search).toHaveFocus())
    fireEvent.change(search, { target: { value: 'alpha' } })
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(input.selectionStart).toBe(0)
    expect(search).toHaveFocus()
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(input.selectionStart).toBe(11)
    expect(search).toHaveFocus()
    fireEvent.keyDown(search, { key: 'Enter', shiftKey: true })
    expect(input.selectionStart).toBe(0)
  })
  it('inserts a figure inside the document when the cursor is past its end', async () => {
    const source = '\\begin{document}\nText\n\\end{document}\n'
    const { handle, input, position } = setup(source)
    input.setSelectionRange(source.length, source.length)
    fireEvent.select(input)
    act(() => handle.current!.insert('FIGURE\n'))
    await waitFor(() => expect(input).toHaveValue('\\begin{document}\nText\nFIGURE\n\\end{document}\n'))
    await waitFor(() => expect(position).toHaveBeenLastCalledWith(4, 1))
  })
  it('navigates to an outline line and inserts at the selected source position', () => {
    const { handle, input } = setup('First\nSecond\nThird')
    act(() => handle.current!.revealLine(2))
    expect(input.selectionStart).toBe(6)
    act(() => handle.current!.insert('Inserted '))
    expect(input).toHaveValue('First\nInserted Second\nThird')
  })
  it('finds and replaces text without leaving the editor', async () => {
    const { input } = setup('alpha beta alpha')
    fireEvent.keyDown(input, { key: 'f', metaKey: true })
    fireEvent.change(screen.getByRole('textbox', { name: 'latex.find' }), { target: { value: 'alpha' } })
    fireEvent.click(screen.getByRole('button', { name: 'latex.toggleReplace' }))
    fireEvent.change(screen.getByLabelText('latex.replacement'), { target: { value: 'gamma' } })
    fireEvent.click(screen.getByRole('button', { name: 'latex.replaceAll' }))
    expect(input).toHaveValue('gamma beta gamma')
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'latex.find' }), { key: 'Escape' })
    await waitFor(() => expect(input).toHaveFocus())
    expect(screen.queryByRole('textbox', { name: 'latex.find' })).not.toBeInTheDocument()
  })
})

it('reveals and selects a source line for inverse PDF navigation', () => {
  const { handle, input, position } = setup('First\nSecond\nThird')
  act(() => handle.current!.revealLine(2, true))
  expect(input).toHaveFocus()
  expect(input.selectionStart).toBe(6)
  expect(input.selectionEnd).toBe(12)
  expect(position).toHaveBeenLastCalledWith(2, 1)
})

it('offers proofreading and custom AI editing for a selection, and dismisses on Escape', () => {
  const onAi = vi.fn()
  render(<LatexSourceEditor value="Some bad text" onChange={vi.fn()} onAi={onAi} />)
  const input = screen.getByLabelText<HTMLTextAreaElement>('latex.source')
  input.setSelectionRange(5, 8)
  fireEvent.mouseUp(input, { clientX: 80, clientY: 90 })
  expect(screen.getByRole('dialog', { name: 'latex.aiSelection' })).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'latex.proofread' }))
  expect(onAi).toHaveBeenLastCalledWith(5, 8, undefined)
  fireEvent.mouseUp(input)
  fireEvent.change(screen.getByRole('textbox', { name: 'latex.editWithAi' }), { target: { value: 'Make it concise' } })
  fireEvent.submit(screen.getByRole('textbox', { name: 'latex.editWithAi' }).closest('form')!)
  expect(onAi).toHaveBeenLastCalledWith(5, 8, 'Make it concise')
  fireEvent.mouseUp(input)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  input.setSelectionRange(0, 0)
  fireEvent.mouseUp(input)
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})


it('retains a multiline selection while entering an AI instruction and clears stale highlights after editing', () => {
  const value = 'First line\nSecond line\nThird line'
  const { container, rerender } = render(<LatexSourceEditor value={value} onChange={vi.fn()} onAi={vi.fn()} />)
  const input = screen.getByLabelText<HTMLTextAreaElement>('latex.source')
  act(() => input.focus())
  input.setSelectionRange(6, 22)
  fireEvent.select(input)
  fireEvent.mouseUp(input)
  const instruction = screen.getByRole('textbox', { name: 'latex.editWithAi' })
  act(() => instruction.focus())
  fireEvent.change(instruction, { target: { value: 'Rewrite this' } })
  const layer = container.querySelector('.latex-selection-layer')!
  expect(layer).toHaveAttribute('data-visible', 'true')
  expect(layer.querySelector('mark')?.textContent).toBe(value.slice(6, 22))
  expect(input.selectionStart).toBe(6)
  expect(input.selectionEnd).toBe(22)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(input).toHaveFocus()
  expect(layer).not.toHaveAttribute('data-visible')
  fireEvent.blur(input)
  rerender(<LatexSourceEditor value="Changed source" onChange={vi.fn()} onAi={vi.fn()} />)
  expect(layer).not.toHaveAttribute('data-visible')
})
