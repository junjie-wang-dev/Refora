import { Trash } from '@phosphor-icons/react'
import { Modal } from '@lobehub/ui'
import { Button as UiButton } from './ui'
import { useConfirmStore } from '../store/confirmStore'

export default function ConfirmDialog() {
  const confirmRequest = useConfirmStore((s) => s.request)
  const dismissConfirm = useConfirmStore((s) => s.dismiss)

  if (!confirmRequest) return null

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
            onClick={() => {
              dismissConfirm()
              try {
                void Promise.resolve(confirmRequest.onConfirm()).catch(() => undefined)
              } catch {
                return
              }
            }}
          >
            {confirmRequest.confirmText}
          </UiButton>
        </div>
      }
      destroyOnClose
    >
      <p className="text-sm text-foreground">{confirmRequest.message}</p>
    </Modal>
  )
}
