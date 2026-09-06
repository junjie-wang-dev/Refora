import { createRef } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import ChatInput, { type ChatInputProps } from '../../src/renderer/components/workspace/ChatInput'
import { initI18n } from '../../src/renderer/i18n'
import type { AiProvider } from '../../src/shared/ipc-types'

initI18n('en')
afterEach(cleanup)

function props(overrides: Partial<ChatInputProps> = {}): ChatInputProps {
  return {
    input: '', onInputChange: vi.fn(), streaming: false, selectedAttachments: [],
    onSelectedAttachmentsChange: vi.fn(), attachMenuOpen: false, onAttachMenuOpenChange: vi.fn(),
    activeWorkspaceId: null, providers: [{} as AiProvider], canSend: false,
    onSend: vi.fn(), onCancel: vi.fn(), textareaRef: createRef(), inputAreaRef: createRef(),
    ...overrides
  }
}

it('shows only Stop while generating with an empty draft and restores Send after completion', () => {
  const inputProps = props({ streaming: true, queueing: true })
  const { rerender } = render(<ChatInput {...inputProps} />)
  const controls = screen.getByTestId('chat-input-controls')
  expect(within(controls).getAllByRole('button')).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
  expect(inputProps.onCancel).toHaveBeenCalledOnce()
  expect(screen.getByRole('textbox')).toHaveFocus()
  expect(screen.queryByRole('button', { name: 'Queue follow-up' })).not.toBeInTheDocument()
  expect(screen.getByRole('textbox')).toHaveAttribute('placeholder', expect.stringContaining('Enter to queue'))
  rerender(<ChatInput {...inputProps} streaming={false} queueing={false} />)
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument()
})

it('offers an explicit queue action for a running draft while keeping the toolbar Stop action', () => {
  const inputProps = props({ input: 'Follow up', streaming: true, queueing: true, canSend: true })
  const { rerender } = render(<ChatInput {...inputProps} />)
  const queue = screen.getByRole('button', { name: 'Queue follow-up' })
  expect(queue).toHaveTextContent('Queue follow-up')
  expect(screen.getByTestId('chat-input-controls')).not.toContainElement(queue)
  expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled()
  fireEvent.click(queue)
  expect(inputProps.onSend).toHaveBeenCalledOnce()
  expect(screen.getByRole('textbox')).toHaveFocus()
  rerender(<ChatInput {...inputProps} input="" canSend={false} />)
  expect(screen.queryByRole('button', { name: 'Queue follow-up' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled()
})

it('keeps typing focus after sending and blocks invalid or composing Enter submissions', () => {
  const inputProps = props({ input: 'Hello', canSend: true })
  const { rerender } = render(<ChatInput {...inputProps} />)
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  expect(inputProps.onSend).toHaveBeenCalledOnce()
  const textarea = screen.getByRole('textbox')
  expect(textarea).toHaveFocus()
  fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true })
  fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })
  expect(inputProps.onSend).toHaveBeenCalledOnce()
  rerender(<ChatInput {...inputProps} canSend={false} />)
  fireEvent.keyDown(textarea, { key: 'Enter' })
  expect(inputProps.onSend).toHaveBeenCalledOnce()
})
