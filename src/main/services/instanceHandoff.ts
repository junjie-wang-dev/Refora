interface FocusableWindow {
  isDestroyed(): boolean
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
}

export function consumeDeepLinkArguments(
  argv: string[],
  handleDeepLink: (value: string) => boolean
): boolean {
  for (const argument of argv.slice(1)) {
    if (handleDeepLink(argument)) return true
  }
  return false
}

export function focusMainWindow(target: FocusableWindow | null): void {
  if (!target || target.isDestroyed()) return
  if (target.isMinimized()) target.restore()
  target.show()
  target.focus()
}

export function handoffSecondInstance(
  argv: string[],
  handleDeepLink: (value: string) => boolean,
  getWindow: () => FocusableWindow | null
): void {
  consumeDeepLinkArguments(argv, handleDeepLink)
  focusMainWindow(getWindow())
}
