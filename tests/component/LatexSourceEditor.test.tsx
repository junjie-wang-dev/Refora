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
    fireEvent.change(screen.getByLabelText('latex.find'), { target: { value: 'alpha' } })
    fireEvent.click(screen.getByRole('button', { name: 'latex.toggleReplace' }))
    fireEvent.change(screen.getByLabelText('latex.replacement'), { target: { value: 'gamma' } })
    fireEvent.click(screen.getByRole('button', { name: 'latex.replaceAll' }))
    expect(input).toHaveValue('gamma beta gamma')
    fireEvent.keyDown(screen.getByLabelText('latex.find'), { key: 'Escape' })
    await waitFor(() => expect(input).toHaveFocus())
    expect(screen.queryByLabelText('latex.find')).not.toBeInTheDocument()
  })
})
