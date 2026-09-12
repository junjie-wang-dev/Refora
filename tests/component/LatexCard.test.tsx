import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import LatexCard from '../../src/renderer/components/workspace/LatexCard'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(cleanup)

it('opens the represented document and removes only its card when requested', () => {
  const onOpen = vi.fn()
  const onRemove = vi.fn()
  render(<LatexCard project={{ id: 'project', title: 'A manuscript', rootFile: 'main.tex', files: ['main.tex', 'references.bib', 'figure.png'] }} onOpen={onOpen} onRemove={onRemove} />)
  expect(screen.getByText('main.tex')).toBeInTheDocument()
  expect(screen.getByText('references.bib')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'A manuscript' }))
  expect(onOpen).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'latex.removeCard' }))
  expect(onRemove).toHaveBeenCalledTimes(1)
  expect(onOpen).toHaveBeenCalledTimes(1)
})
