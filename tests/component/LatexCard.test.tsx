import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import LatexCard from '../../src/renderer/components/workspace/LatexCard'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, values?: { name?: string; count?: number }) => values?.name ? `${key}: ${values.name}` : values?.count !== undefined ? `${key}: ${values.count}` : key }) }))
afterEach(cleanup)

it('opens the represented project and removes only its card when requested', () => {
  const onOpen = vi.fn()
  const onRemove = vi.fn()
  render(<LatexCard project={{ id: 'project', title: 'A manuscript', rootFile: 'main.tex', files: ['main.tex', 'references.bib', 'figure.png'], template: 'IEEE Conference' }} onOpen={onOpen} onRemove={onRemove} />)
  expect(screen.getByText('latex.template: IEEE Conference')).toBeInTheDocument()
  expect(screen.getByText('latex.fileCount: 3 · latex.figureCount: 1')).toBeInTheDocument()
  expect(screen.queryByText('main.tex')).not.toBeInTheDocument()
  expect(screen.queryByText('references.bib')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'A manuscript' }))
  expect(onOpen).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'latex.removeCard' }))
  expect(onRemove).toHaveBeenCalledTimes(1)
  expect(onOpen).toHaveBeenCalledTimes(1)
})

it('shows an explicit fallback for projects without a recognized template', () => {
  render(<LatexCard project={{ id: 'generic', title: 'Generic project', rootFile: 'main.tex', files: ['main.tex'] }} onOpen={vi.fn()} onRemove={vi.fn()} />)
  expect(screen.getByText('latex.template: latex.unknownTemplate')).toBeInTheDocument()
})
