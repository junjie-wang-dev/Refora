export function latexSelectionLines(content: string, start: number, end: number) {
  return { startLine: content.slice(0, start).split('\n').length, endLine: content.slice(0, Math.max(start, end - 1)).split('\n').length }
}

export function latexAiPrompt(path: string, content: string, start: number, end: number, instruction: string): string {
  const { startLine, endLine } = latexSelectionLines(content, start, end)
  const selected = content.slice(start, end)
  const fence = '`'.repeat(Array.from(selected.matchAll(/`+/g)).reduce((length, match) => Math.max(length, match[0].length + 1), 3))
  return `${instruction}\n\n${path}:${startLine}-${endLine}\n${fence}latex\n${selected}\n${fence}`
}
