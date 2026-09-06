import { useEffect, useState, type RefObject } from 'react'

export function useMarkdownReaderLayout(rootRef: RefObject<HTMLElement | null>) {
  const [compact, setCompact] = useState(false)
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const observer = new ResizeObserver((entries) => setCompact((entries[0]?.contentRect.width ?? root.clientWidth) < 760))
    observer.observe(root)
    return () => observer.disconnect()
  }, [rootRef])
  return compact
}
