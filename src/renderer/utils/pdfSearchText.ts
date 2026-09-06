import type { TextItem } from 'pdfjs-dist/types/src/display/api'

export interface PdfSearchFragment {
  itemIndex: number
  start: number
  end: number
}

export interface PdfSearchMatch {
  page: number
  fragments: PdfSearchFragment[]
}

export interface SearchablePdfPage {
  text: string
  locations: Array<PdfSearchFragment | null>
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const cjkCharacter = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

function normalizeCharacters(value: string): string {
  return value.normalize('NFKC').toLowerCase()
    .replace(/[\u00ad\u200b\ufeff]/gu, '')
    .replace(/[\u2010\u2011]/gu, '-')
    .replace(/[\u2018\u2019]/gu, "'")
    .replace(/[\u201c\u201d]/gu, '"')
    .replace(/\u03c2/gu, '\u03c3')
}

export function normalizePdfSearchQuery(query: string): string {
  return normalizeCharacters(query).replace(/\s+/gu, ' ').trim()
}

function itemSeparation(previous: TextItem, current: TextItem): {
  newLine: boolean
  wordGap: boolean
} {
  const previousTransform = previous.transform as number[]
  const currentTransform = current.transform as number[]
  if (!previousTransform || !currentTransform || previousTransform.length < 6 || currentTransform.length < 6) {
    return { newLine: false, wordGap: true }
  }
  const [a, b, c, d, x, y] = previousTransform
  const [, , , , nextX, nextY] = currentTransform
  const axisLength = Math.hypot(a, b)
  if (!axisLength) return { newLine: false, wordGap: true }
  const fontSize = Math.hypot(c, d) || previous.height || axisLength
  const dx = nextX - x
  const dy = nextY - y
  const advance = (dx * a + dy * b) / axisLength
  const perpendicular = Math.abs((dy * a - dx * b) / axisLength)
  const gap = previous.dir === 'rtl'
    ? -advance - current.width
    : advance - previous.width
  return {
    newLine: perpendicular > fontSize * 0.5,
    wordGap: gap > fontSize * 0.15
  }
}

export function searchablePdfPage(items: TextItem[]): SearchablePdfPage {
  const characters: string[] = []
  const locations: Array<PdfSearchFragment | null> = []
  let previous: TextItem | null = null
  let pendingLineEnd = false
  const append = (character: string, location: PdfSearchFragment | null) => {
    if (/\s/u.test(character)) {
      if (characters.length === 0 || characters.at(-1) === ' ') return
      characters.push(' ')
    } else {
      characters.push(character)
    }
    locations.push(location)
  }
  items.forEach((item, itemIndex) => {
    const hasText = item.str.trim().length > 0
    let joinLineWord = false
    if (previous && hasText) {
      const separation = itemSeparation(previous, item)
      const newLine = pendingLineEnd || separation.newLine
      const lineSuffix = characters.slice(-8).join('')
      const hyphenated = /\p{L}-\s*$/u.test(lineSuffix)
        || (/\u00ad\s*$/u.test(previous.str) && /\p{L}\s*$/u.test(lineSuffix))
      joinLineWord = newLine && hyphenated
        && /^\s*\p{L}/u.test(item.str)
      if (joinLineWord) {
        while (characters.at(-1) === ' ') {
          characters.pop()
          locations.pop()
        }
        if (characters.at(-1) === '-') {
          characters.pop()
          locations.pop()
        }
      } else {
        const previousCharacter = [...previous.str.trimEnd()].at(-1) ?? ''
        const nextCharacter = [...item.str.trimStart()][0] ?? ''
        const cjkBoundary = cjkCharacter.test(previousCharacter) && cjkCharacter.test(nextCharacter)
        if ((newLine || separation.wordGap) && !cjkBoundary) append(' ', null)
      }
    }
    for (const { segment, index } of graphemes.segment(item.str)) {
      const location = { itemIndex, start: index, end: index + segment.length }
      const normalized = normalizeCharacters(segment)
      if (joinLineWord && /^\s+$/u.test(normalized)) continue
      if (normalized) joinLineWord = false
      for (let offset = 0; offset < normalized.length; offset += 1) append(normalized[offset], location)
    }
    if (hasText) {
      previous = item
      pendingLineEnd = item.hasEOL
    } else {
      pendingLineEnd ||= item.hasEOL
    }
  })
  return { text: characters.join(''), locations }
}

export function findPdfPageMatches(
  page: number,
  cached: SearchablePdfPage,
  normalizedQuery: string
): PdfSearchMatch[] {
  if (!normalizedQuery) return []
  const matches: PdfSearchMatch[] = []
  let matchStart = cached.text.indexOf(normalizedQuery)
  while (matchStart >= 0) {
    const matchEnd = matchStart + normalizedQuery.length
    const fragments: PdfSearchFragment[] = []
    for (let offset = matchStart; offset < matchEnd; offset += 1) {
      const location = cached.locations[offset]
      if (!location) continue
      const previous = fragments.at(-1)
      if (previous && previous.itemIndex === location.itemIndex && location.start <= previous.end) {
        previous.end = Math.max(previous.end, location.end)
      } else {
        fragments.push({ ...location })
      }
    }
    if (fragments.length > 0) matches.push({ page, fragments })
    matchStart = cached.text.indexOf(normalizedQuery, matchEnd)
  }
  return matches
}
