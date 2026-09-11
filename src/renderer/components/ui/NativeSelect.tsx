import type { ComponentProps } from 'react'
import { CaretDown } from '@phosphor-icons/react'

export function NativeSelect({ className, style, multiple, size, ...props }: ComponentProps<'select'>) {
  const dropdown = !multiple && (size ?? 0) <= 1
  return (
    <span className="relative inline-grid min-w-0">
      <select
        {...props}
        multiple={multiple}
        size={size}
        className={`${dropdown ? 'appearance-none' : ''} ${className ?? ''}`}
        style={{ ...style, ...(dropdown ? { paddingInlineEnd: '2rem' } : {}) }}
      />
      {dropdown && (
        <CaretDown aria-hidden size={14}
          className={`pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-muted ${props.disabled ? 'opacity-40' : ''}`} />
      )}
    </span>
  )
}
