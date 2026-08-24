import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { showContextMenu } from '@lobehub/ui'
import type { ChatMessage } from '../../src/shared/ipc-types'
import ChatMessages from '../../src/renderer/components/workspace/ChatMessages'

vi.mock('@lobehub/ui', async () => import('../mocks/lobehub-ui'))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

function renderMessages(messages: ChatMessage[]) {
  return render(
    <ChatMessages
      messages={messages}
      traceSteps={[]}
      streaming={false}
      streamingText=""
      streamingReasoning=""
      activeRunId={null}
      elapsedSeconds={0}
      loadingHistory={false}
      providers={[]}
      onRegenerate={vi.fn()}
      onSuggestionClick={vi.fn()}
      scrollRef={{ current: null }}
      inputAreaHeight={0}
      stickToBottomRef={{ current: true }}
    />
  )
}

function selectSubstring(element: HTMLElement, text: string) {
  const textNode = element.firstChild
  if (!textNode) throw new Error('Expected a text node')
  const fullText = textNode.textContent ?? ''
  const start = fullText.indexOf(text)
  if (start < 0) throw new Error(`Unable to find selection text: ${text}`)
  const range = document.createRange()
  range.setStart(textNode, start)
  range.setEnd(textNode, start + text.length)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

afterEach(() => {
  cleanup()
  window.getSelection()?.removeAllRanges()
  vi.mocked(showContextMenu).mockReset()
  vi.restoreAllMocks()
})

describe('ChatMessages selection context menu', () => {
  it.each([
    ['user', 'User selected passage'],
    ['assistant', 'Assistant selected passage']
  ] as const)('copies a selected portion of a %s message', async (role, content) => {
    const writeText = vi.spyOn(window.api.clipboard, 'writeText').mockResolvedValue()
    renderMessages([{
      id: `${role}-1`,
      threadId: 'thread-1',
      role,
      content,
      createdAt: 1
    }])
    const messageText = screen.getByText(content)
    selectSubstring(messageText, 'selected')

    fireEvent.contextMenu(messageText)

    const items = vi.mocked(showContextMenu).mock.calls[0][0] as Array<{
      key: string
      label: string
      onClick?: () => void | Promise<void>
    }>
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      key: 'copySelection',
      label: 'workspace.chat.copySelection'
    })

    await act(async () => {
      await items[0].onClick?.()
    })
    expect(writeText).toHaveBeenCalledWith('selected')
  })

  it('does not offer copy when the message has no text selection', () => {
    renderMessages([{
      id: 'user-1',
      threadId: 'thread-1',
      role: 'user',
      content: 'Nothing selected',
      createdAt: 1
    }])

    fireEvent.contextMenu(screen.getByText('Nothing selected'))

    expect(showContextMenu).not.toHaveBeenCalled()
  })
})
