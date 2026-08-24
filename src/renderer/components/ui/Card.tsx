export type CardVariant = 'default' | 'elevated' | 'outlined'

const VARIANT_CLASSES: Record<CardVariant, string> = {
  default: 'border border-border bg-panel shadow-sm',
  elevated: 'border border-border bg-panel shadow-md',
  outlined: 'border border-border bg-panel',
}

export function cardClassName(
  variant: CardVariant = 'default',
  hoverable = false,
  extra?: string
): string {
  return [
    'card rounded-xl',
    VARIANT_CLASSES[variant],
    hoverable ? 'transition-colors hover:border-accent' : '',
    extra,
  ]
    .filter(Boolean)
    .join(' ')
}
