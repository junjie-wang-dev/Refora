import type { ComponentProps } from 'react'
import { IconTooltip } from './Tooltip'

interface Props extends ComponentProps<'button'> {
  label: string
  shortcut?: string
  active?: boolean
}

export function ReaderToolbarButton({ label, shortcut, active, className = '', children, ...props }: Props) {
  return <IconTooltip label={label} shortcut={shortcut} appearance="sidebar"><button
    type="button"
    aria-label={label}
    data-shortcut={shortcut}
    aria-pressed={active}
    className={`reader-toolbar-button flex h-7 min-w-7 shrink-0 items-center justify-center rounded-md px-1.5 text-muted transition-colors hover:bg-hover hover:text-foreground disabled:opacity-35 aria-pressed:bg-active aria-pressed:text-accent ${className}`}
    {...props}
  >{children}</button></IconTooltip>
}
