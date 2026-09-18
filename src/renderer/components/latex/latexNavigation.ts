export interface LatexHeading { title: string; line: number; level: number; file?: string }
export interface LatexDiagnostic { file?: string; line?: number; message: string; severity: 'error' | 'warning' }
export interface LatexFileTree { files: string[]; folders: Record<string, LatexFileTree> }
export interface LatexProjectSource { path: string; content: string }

function outlineSource(source: string): string {
  let result = ''
  let index = 0
  const mask = (start: number, end: number) => { result += source.slice(start, end).replace(/[^\n]/g, ' '); index = end }
  while (index < source.length) {
    if (source[index] === '%') {
      const end = source.indexOf('\n', index)
      mask(index, end < 0 ? source.length : end)
    } else if (source[index] === '\\') {
      const rest = source.slice(index)
      const environment = /^\\begin\{(verbatim\*?|lstlisting|minted|comment)\}/.exec(rest)
      const verb = /^\\verb\*?([^a-zA-Z\s])/.exec(rest)
      if (environment) {
        const closing = `\\end{${environment[1]}}`
        const end = source.indexOf(closing, index + environment[0].length)
        mask(index, end < 0 ? source.length : end + closing.length)
      } else if (verb) {
        const end = source.indexOf(verb[1], index + verb[0].length)
        const newline = source.indexOf('\n', index)
        mask(index, end >= 0 && (newline < 0 || end < newline) ? end + 1 : newline >= 0 ? newline : source.length)
      } else { result += source.slice(index, index + 2); index += 2 }
    } else result += source[index++]
  }
  return result
}

export function latexOutline(source: string): LatexHeading[] {
  const cleaned = outlineSource(source)
  const headings: LatexHeading[] = []
  const pattern = /\\(chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*(?:\[[\s\S]*?\]\s*)?\{/g
  for (const match of cleaned.matchAll(pattern)) {
    const start = match.index + match[0].length
    let end = start
    let depth = 1
    while (end < cleaned.length && depth) {
      if (cleaned[end] === '\\') { end += 2; continue }
      if (cleaned[end] === '{') depth++
      if (cleaned[end] === '}') depth--
      if (depth) end++
    }
    if (depth) continue
    const title = cleaned.slice(start, end).replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?/g, '').replace(/[{}]/g, '').replace(/\s+/g, ' ').trim()
    headings.push({ title, line: cleaned.slice(0, match.index).split('\n').length, level: ['chapter', 'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph'].indexOf(match[1]) })
  }
  return headings
}

function projectPath(path: string): string | undefined {
  if (path.startsWith('/')) return undefined
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') { if (!parts.length) return undefined; parts.pop() }
    else parts.push(part)
  }
  return parts.join('/')
}

export function latexProjectOutline(sources: LatexProjectSource[], rootFile: string): LatexHeading[] {
  const byPath = new Map(sources.map((source) => [source.path, source.content]))
  const visited = new Set<string>()
  const result: LatexHeading[] = []
  const visit = (path: string) => {
    if (visited.has(path) || !byPath.has(path)) return
    visited.add(path)
    const source = byPath.get(path)!
    const events: ({ line: number; heading: LatexHeading } | { line: number; include: string })[] = latexOutline(source).map((heading) => ({ line: heading.line, heading }))
    const cleaned = outlineSource(source)
    for (const match of cleaned.matchAll(/\\(?:input|include)\s*\{([^}]+)\}/g)) events.push({ line: cleaned.slice(0, match.index).split('\n').length, include: match[1].trim() })
    for (const event of events.sort((a, b) => a.line - b.line)) {
      if ('heading' in event) result.push({ ...event.heading, file: path })
      else {
        const target = /\.tex$/i.test(event.include) ? event.include : `${event.include}.tex`
        const relative = path.includes('/') ? `${path.slice(0, path.lastIndexOf('/') + 1)}${target}` : target
        const rootPath = projectPath(target)
        const relativePath = projectPath(relative)
        if (rootPath && byPath.has(rootPath)) visit(rootPath)
        else if (relativePath) visit(relativePath)
      }
    }
  }
  visit(rootFile)
  for (const source of sources) if (/\.tex$/i.test(source.path)) visit(source.path)
  return result
}

export function latexFileTree(paths: string[]): LatexFileTree {
  const root: LatexFileTree = { files: [], folders: Object.create(null) }
  for (const path of paths) {
    const parts = path.split('/')
    let node = root
    for (const part of parts.slice(0, -1)) {
      node.folders[part] ??= { files: [], folders: Object.create(null) }
      node = node.folders[part]
    }
    node.files.push(path)
  }
  return root
}

export function latexDiagnostics(log: string): LatexDiagnostic[] {
  const seen = new Set<string>()
  const diagnostics: LatexDiagnostic[] = []
  const lines = log.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const text = lines[index].trim()
    const located = text.match(/^(.+?\.(?:tex|sty|cls|bib|bst|cfg|def|clo|bbx|cbx|lbx|fd)):(\d+):\s*(.+)$/i)
    let diagnostic: LatexDiagnostic | undefined
    if (located) diagnostic = { file: located[1].replace(/^\.\//, ''), line: Number(located[2]), message: located[3], severity: /warning|(?:over|under)full/i.test(located[3]) ? 'warning' : 'error' }
    else if (/^(?:LaTeX(?: Font)?|Package \S+|Class \S+) Warning:|^(?:Over|Under)full \\[hv]box/.test(text)) {
      let message = text
      while (!/[.!]$/.test(message) && index + 1 < lines.length && /^\s+\S|^\([^)]+\)\s+/.test(lines[index + 1])) message += ` ${lines[++index].trim()}`
      const line = message.match(/(?:input line|at lines?)\s+(\d+)/i)
      diagnostic = { message, severity: 'warning', ...(line ? { line: Number(line[1]) } : {}) }
    } else if (/^!\s+/.test(text)) {
      const line = lines.slice(index + 1, index + 5).map((value) => value.match(/^l\.(\d+)\s/)).find(Boolean)
      diagnostic = { message: text.replace(/^!\s+/, ''), severity: 'error', ...(line ? { line: Number(line[1]) } : {}) }
    }
    if (!diagnostic) continue
    const key = JSON.stringify(diagnostic)
    if (!seen.has(key)) { seen.add(key); diagnostics.push(diagnostic) }
  }
  return diagnostics
}

export function isEditableLatexFile(path: string): boolean {
  return /\.(tex|bib|bst|cls|sty|cfg|def|clo|txt|bbl|bbx|cbx|lbx|ist|fd)$/i.test(path)
}
