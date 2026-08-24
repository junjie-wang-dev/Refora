function normalizedPath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/g, '')
  return normalized || '/'
}

export function isPathWithinDirectory(filePath: string, directoryPath: string): boolean {
  const file = normalizedPath(filePath)
  const directory = normalizedPath(directoryPath)
  if (file === directory) return true
  const prefix = directory === '/' ? '/' : `${directory}/`
  return file.startsWith(prefix)
}
