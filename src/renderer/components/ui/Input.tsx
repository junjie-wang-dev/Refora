import { forwardRef, type InputHTMLAttributes } from 'react'

export type InputVariant = 'outlined' | 'filled' | 'borderless'
export type InputSize = 'sm' | 'md'

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  variant?: InputVariant
  inputSize?: InputSize
  error?: boolean
  focusRing?: boolean
  onPressEnter?: () => void
}

const SIZE_CLASSES: Record<InputSize, string> = {
  sm: 'h-7 text-xs px-2.5',
  md: 'h-8 text-xs px-3',
}

const VARIANT_CLASSES: Record<InputVariant, string> = {
  outlined:
    'border border-border bg-background hover:border-accent focus:border-accent',
  filled:
    'border border-transparent bg-background hover:border-border focus:border-accent',
  borderless:
    'border border-transparent bg-transparent hover:bg-hover focus:bg-hover',
}

const BASE_CLASS =
  'w-full rounded-lg text-foreground placeholder:text-muted focus:outline-none focus-visible:outline-none no-drag transition-colors duration-150'

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    variant = 'outlined',
    inputSize = 'md',
    error = false,
    focusRing = true,
    onPressEnter,
    className,
    onKeyDown,
    ...props
  },
  ref
) {
  return (
    <input
      ref={ref}
      className={[
        BASE_CLASS,
        SIZE_CLASSES[inputSize],
        focusRing ? 'focus:ring-1 focus:ring-accent' : 'focus:ring-0',
        error ? 'border-error focus:border-error focus:ring-error' : VARIANT_CLASSES[variant],
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && onPressEnter) {
          e.preventDefault()
          onPressEnter()
        }
        onKeyDown?.(e)
      }}
      {...props}
    />
  )
})
