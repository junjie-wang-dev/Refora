import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { NativeSelect } from '../../src/renderer/components/ui/NativeSelect'
import { Button, Modal, Select } from '../../src/renderer/components/ui/LobeControls'

function expectPhosphorIcons(root: ParentNode) {
  const icons = root.querySelectorAll('svg')
  expect(icons.length).toBeGreaterThan(0)
  icons.forEach((icon) => expect(icon).toHaveAttribute('viewBox', '0 0 256 256'))
  expect(root.querySelector('svg.lucide, svg[data-icon]')).toBeNull()
}

afterEach(cleanup)

describe('Phosphor component controls', () => {
  it('keeps native form semantics with a Phosphor dropdown arrow', () => {
    const onChange = vi.fn()
    const view = render(
      <label>Protocol<NativeSelect defaultValue="one" onChange={onChange}>
        <option value="one">One</option><option value="two">Two</option>
      </NativeSelect></label>
    )
    const select = screen.getByRole('combobox', { name: 'Protocol' })
    expect(select).toHaveClass('appearance-none')
    expectPhosphorIcons(view.container)
    fireEvent.change(select, { target: { value: 'two' } })
    expect(select).toHaveValue('two')
    expect(onChange).toHaveBeenCalledOnce()
  })

  it('uses a Phosphor loading icon and prevents repeated submissions', () => {
    const onClick = vi.fn()
    const view = render(<Button loading onClick={onClick}>Save</Button>)
    const button = screen.getByRole('button', { name: 'Save' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
    expectPhosphorIcons(button)
    fireEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()
    view.rerender(<Button onClick={onClick}>Save</Button>)
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('closes a dialog through its Phosphor close button', () => {
    const onCancel = vi.fn()
    render(<Modal open title="Settings" footer={null} onCancel={onCancel}>Preferences</Modal>)
    const close = screen.getByRole('button', { name: 'Close' })
    expectPhosphorIcons(close)
    fireEvent.click(close)
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('uses Phosphor icons for dropdown choices, tag removal, and clearing', async () => {
    const onChange = vi.fn()
    const view = render(
      <Select open mode="multiple" allowClear defaultValue={['one']} onChange={onChange}
        options={[{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }]} />
    )
    await waitFor(() => expect(document.querySelector('.ant-select-dropdown')).not.toBeNull())
    expectPhosphorIcons(document.body)
    fireEvent.click(view.container.querySelector('.ant-select-selection-item-remove')!)
    expect(onChange).toHaveBeenCalledWith([], [])
  })

  it('uses Phosphor icons for loading and an empty dropdown', async () => {
    render(<Select open loading options={[]} />)
    await waitFor(() => expect(document.querySelector('.ant-empty')).not.toBeNull())
    expectPhosphorIcons(document.body)
    expect(document.querySelector('.animate-spin')).not.toBeNull()
  })
})
