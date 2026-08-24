import { describe, expect, it } from 'vitest'
import { isPathWithinDirectory } from '../../src/renderer/utils/filePath'

describe('isPathWithinDirectory', () => {
  it('matches only the directory itself or a path-segment descendant', () => {
    expect(isPathWithinDirectory('/library/paper.pdf', '/library')).toBe(true)
    expect(isPathWithinDirectory('/library', '/library/')).toBe(true)
    expect(isPathWithinDirectory('/library-old/paper.pdf', '/library')).toBe(false)
  })

  it('normalizes Windows separators without importing Node path helpers', () => {
    expect(isPathWithinDirectory('C:\\Papers\\topic\\paper.pdf', 'C:\\Papers')).toBe(true)
    expect(isPathWithinDirectory('C:\\Papers-old\\paper.pdf', 'C:\\Papers')).toBe(false)
  })
})
