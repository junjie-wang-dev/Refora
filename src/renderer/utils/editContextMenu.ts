export function preserveNativeEditContextMenu(event: MouseEvent): void {
  const target = event.target
  if (!(target instanceof HTMLElement)) return
  if (
    (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) &&
    (target.readOnly || target.disabled)
  ) return
  if (target.closest('input, textarea') || target.isContentEditable) {
    event.stopPropagation()
  }
}
