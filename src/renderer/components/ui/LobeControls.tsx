import {
  Button as LobeButton,
  Modal as LobeModal,
  Select as LobeSelect,
  type ButtonProps as LobeButtonProps,
  type ModalProps,
  type SelectProps
} from '@lobehub/ui'
import { Empty } from 'antd'
import { CaretDown, Check, CircleNotch, Tray, X, XCircle } from '@phosphor-icons/react'

type ButtonProps = Omit<LobeButtonProps, 'loading'> & { loading?: boolean }

export function Button({ loading, disabled, icon, ...props }: ButtonProps) {
  return (
    <LobeButton
      {...props}
      loading={false}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      icon={loading ? <CircleNotch aria-hidden size="1.2em" className="animate-spin" /> : icon}
    />
  )
}

export function Modal(props: ModalProps) {
  return <LobeModal closeIcon={<X aria-hidden size={20} />} {...props} />
}

export function Select({ loading, allowClear, ...props }: SelectProps) {
  return (
    <LobeSelect
      loading={loading}
      suffixIcon={loading
        ? <CircleNotch aria-hidden size={14} className="animate-spin" />
        : <CaretDown aria-hidden size={14} />}
      allowClear={allowClear ? {
        clearIcon: <XCircle aria-hidden size={14} />,
        ...(typeof allowClear === 'object' ? allowClear : {})
      } : allowClear}
      removeIcon={<X aria-hidden size={12} />}
      menuItemSelectedIcon={<Check aria-hidden size={14} />}
      notFoundContent={<Empty image={<Tray aria-hidden size={32} />} styles={{ image: { height: 32 } }} />}
      {...props}
    />
  )
}
