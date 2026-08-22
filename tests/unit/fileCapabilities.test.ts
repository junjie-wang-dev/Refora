import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRendererPathCapabilities } from '../../src/main/services/fileCapabilities'

const roots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'refora-capabilities-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('renderer path capabilities', () => {
  it('allows an authorized file exactly once and returns its real path', () => {
    const root = makeRoot()
    const file = join(root, 'paper.pdf')
    writeFileSync(file, 'pdf')
    const capabilities = createRendererPathCapabilities()

    const authorized = capabilities.authorizeFile(file)

    expect(capabilities.consumeFile(file, ['.pdf'])).toBe(authorized)
    expect(() => capabilities.consumeFile(file, ['.pdf'])).toThrow('not selected by the user')
  })

  it('rejects unapproved paths, wrong extensions, and expired approvals', () => {
    const root = makeRoot()
    const text = join(root, 'notes.txt')
    const pdf = join(root, 'paper.pdf')
    writeFileSync(text, 'text')
    writeFileSync(pdf, 'pdf')
    let now = 100
    const capabilities = createRendererPathCapabilities(50, () => now)

    expect(() => capabilities.consumeFile(pdf)).toThrow('not selected by the user')
    capabilities.authorizeFile(text)
    expect(() => capabilities.consumeFile(text, ['.pdf'])).toThrow('File must use')
    capabilities.authorizeFile(pdf)
    now = 151
    expect(() => capabilities.consumeFile(pdf)).toThrow('not selected by the user')
  })

  it('keeps file and directory capabilities distinct and rejects symlinks', () => {
    const root = makeRoot()
    const directory = join(root, 'library')
    const file = join(root, 'paper.pdf')
    const alias = join(root, 'alias.pdf')
    mkdirSync(directory)
    writeFileSync(file, 'pdf')
    symlinkSync(file, alias)
    const capabilities = createRendererPathCapabilities()

    capabilities.authorizeDirectory(directory)
    expect(() => capabilities.consumeFile(directory)).toThrow('regular file')
    capabilities.authorizeDirectory(directory)
    expect(capabilities.consumeDirectory(directory)).toBe(realpathSync(directory))
    expect(() => capabilities.authorizeFile(alias)).toThrow('Symbolic links')
  })
})
