import { useEffect, useState } from 'react'
import { Trash } from '@phosphor-icons/react'
import { Modal } from '@lobehub/ui'
import { Button as UiButton, Input as UiInput } from './ui'
import { useConfirmStore } from '../store/confirmStore'

export default function ConfirmDialog() {
  const confirmRequest = useConfirmStore((s) => s.request)
  const dismissConfirm = useConfirmStore((s) => s.dismiss)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    setDraft(confirmRequest?.input?.defaultValue ?? '')
  }, [confirmRequest])

  if (!confirmRequest) return null

  const submit = () => {
    dismissConfirm()
    try {
      void Promise.resolve(confirmRequest.onConfirm(confirmRequest.input ? draft : undefined))
        .catch(() => undefined)
    } catch {
      return
    }
  }

  return (
    <Modal
      open
      onCancel={dismissConfirm}
      title={confirmRequest.title}
      footer={
        <div className="flex justify-end gap-2">
          <UiButton variant="ghost" size="md" onClick={dismissConfirm}>
            {confirmRequest.cancelText}
          </UiButton>
          <UiButton
            variant={confirmRequest.danger ? 'danger' : 'primary'}
            size="md"
            icon={confirmRequest.danger ? <Trash className="h-3.5 w-3.5" /> : undefined}
            onClick={submit}
          >
            {confirmRequest.confirmText}
          </UiButton>
        </div>
      }
      destroyOnClose
    >
      {confirmRequest.input ? (
        <UiInput
          value={draft}
          placeholder={confirmRequest.input.placeholder}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onPressEnter={submit}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              dismissConfirm()
            }
          }}
        />
      ) : (
        <p className="text-sm text-foreground">{confirmRequest.message}</p>
      )}
    </Modal>
  )
}
