import type { ReactNode } from 'react'

export function highlightMatch(text: string, query: string): ReactNode {
  const tokens = query.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return text
  const pattern = tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const parts = text.split(new RegExp(`(${pattern})`, 'gi'))
  return parts.map((part, index) =>
    index % 2 === 1 ? (
      <mark key={index} className="rounded-[3px] bg-warning/30 px-0.5 text-inherit">
        {part}
      </mark>
    ) : (
      <span key={index}>{part}</span>
    )
  )
}
