export function tableRows(table: HTMLTableElement): string[][] {
  return Array.from(table.rows, (row) => Array.from(row.cells, (cell) => {
    const content = cell.cloneNode(true) as HTMLElement
    for (const math of content.querySelectorAll('.katex')) {
      const source = math.querySelector('annotation')?.textContent
      if (source) math.replaceWith(document.createTextNode(source))
    }
    return content.textContent?.trim() ?? ''
  }))
}

export function tableCsv(rows: string[][]): string {
  return rows.map((row) => row.map((value) => {
    const safe = /^[\s]*[=+@-]/.test(value) && !/^\s*[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\s*$/.test(value)
      ? `'${value}`
      : value
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
  }).join(',')).join('\r\n')
}
