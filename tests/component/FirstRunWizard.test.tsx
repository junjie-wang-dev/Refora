import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'

const { openDirectory, librarySwitch } = vi.hoisted(() => ({
  openDirectory: vi.fn(),
  librarySwitch: vi.fn()
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, d?: string) => d ?? k })
}))

vi.mock('../../src/renderer/ipc', () => ({
  api: {
    dialog: { openDirectory: (...a: unknown[]) => openDirectory(...a) },
    library: { switch: (...a: unknown[]) => librarySwitch(...a) }
  }
}))

import FirstRunWizard from '../../src/renderer/components/FirstRunWizard'

afterEach(() => {
  cleanup()
  openDirectory.mockReset()
  librarySwitch.mockReset()
})

describe('FirstRunWizard', () => {
  it('renders choose-library button', () => {
    render(<FirstRunWizard onDone={vi.fn()} />)
    expect(screen.getByText('wizard.chooseLibrary')).toBeInTheDocument()
  })

  it('does nothing when dialog cancelled (null path)', async () => {
    openDirectory.mockResolvedValue(null)
    const onDone = vi.fn()
    render(<FirstRunWizard onDone={onDone} />)
    fireEvent.click(screen.getByText('wizard.chooseLibrary'))
    await waitFor(() => expect(openDirectory).toHaveBeenCalled())
    expect(librarySwitch).not.toHaveBeenCalled()
    expect(onDone).not.toHaveBeenCalled()
  })

  it('switches library and calls onDone on success', async () => {
    openDirectory.mockResolvedValue('/my/lib')
    librarySwitch.mockResolvedValue({ libraryFolderPath: '/my/lib', dbExisted: true, scanned: 0, imported: 0, skipped: 0, errors: [] })
    const onDone = vi.fn()
    render(<FirstRunWizard onDone={onDone} />)
    fireEvent.click(screen.getByText('wizard.chooseLibrary'))
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    expect(librarySwitch).toHaveBeenCalledWith('/my/lib')
  })

  it('shows error message on failure', async () => {
    openDirectory.mockResolvedValue('/my/lib')
    librarySwitch.mockRejectedValue(new Error('disk full'))
    render(<FirstRunWizard onDone={vi.fn()} />)
    fireEvent.click(screen.getByText('wizard.chooseLibrary'))
    await waitFor(() => expect(screen.getByText('disk full')).toBeInTheDocument())
  })
})
