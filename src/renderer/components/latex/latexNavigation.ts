export interface LatexHeading { title: string; line: number; level: number }
export interface LatexDiagnostic { file: string; line: number; message: string }
export interface LatexFileTree { files: string[]; folders: Record<string, LatexFileTree> }

export function latexOutline(source: string): LatexHeading[] {
  return source.split('\n').flatMap((line, index) => {
    const match = line.replace(/(?<!\\)%.*$/, '').match(/\\(chapter|section|subsection|subsubsection)\*?(?:\[[^\]]*\])?\{([^}]+)\}/)
    return match ? [{ title: match[2], line: index + 1, level: ['chapter', 'section', 'subsection', 'subsubsection'].indexOf(match[1]) }] : []
  })
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
  return log.split('\n').flatMap((line) => {
    const match = line.match(/^(.+?\.tex):(\d+):\s*(.+)$/)
    if (!match) return []
    const key = `${match[1]}:${match[2]}:${match[3]}`
    if (seen.has(key)) return []
    seen.add(key)
    return [{ file: match[1].replace(/^\.\//, ''), line: Number(match[2]), message: match[3] }]
  })
}
