import { create } from 'zustand'

export interface ConfirmInputOptions {
  defaultValue?: string
  placeholder?: string
}

export interface ConfirmRequest {
  title: string
  message: string
  confirmText: string
  cancelText: string
  danger: boolean
  input?: ConfirmInputOptions
  onConfirm: (inputValue?: string) => void | Promise<void>
}

interface ConfirmState {
  request: ConfirmRequest | null
  show: (opts: {
    title: string
    message: string
    confirmText?: string
    cancelText?: string
    danger?: boolean
    input?: ConfirmInputOptions
    onConfirm: (inputValue?: string) => void | Promise<void>
  }) => void
  dismiss: () => void
}

export const useConfirmStore = create<ConfirmState>((set) => ({
  request: null,
  show: (opts) =>
    set({
      request: {
        title: opts.title,
        message: opts.message,
        confirmText: opts.confirmText ?? 'OK',
        cancelText: opts.cancelText ?? 'Cancel',
        danger: opts.danger ?? false,
        ...(opts.input ? { input: opts.input } : {}),
        onConfirm: opts.onConfirm
      }
    }),
  dismiss: () => set({ request: null })
}))
