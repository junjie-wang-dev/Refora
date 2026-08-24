import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRendererPathCapabilities } from '../../src/main/services/fileCapabilities'

const roots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'refora-capabilities-'))
  roots.push(root)
  return root
}

afterEach(() => {
  vi.useRealTimers()
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

  it('rejects paths that cannot be inspected', () => {
    const root = makeRoot()
    const missing = join(root, 'missing.pdf')
    const capabilities = createRendererPathCapabilities()

    expect(() => capabilities.authorizeFile(missing)).toThrow(`Unable to inspect path: ${missing}`)
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

  it('consumes a batch atomically only after every file passes validation', () => {
    const root = makeRoot()
    const first = join(root, 'first.pdf')
    const second = join(root, 'second.txt')
    writeFileSync(first, 'pdf')
    writeFileSync(second, 'text')
    const capabilities = createRendererPathCapabilities()
    capabilities.authorizeFile(first)
    capabilities.authorizeFile(second)

    expect(() => capabilities.consumeFiles([first, second], ['.pdf'])).toThrow('File must use')
    expect(capabilities.consumeFile(first, ['.pdf'])).toBe(realpathSync(first))
    expect(capabilities.consumeFile(second, ['.txt'])).toBe(realpathSync(second))
  })

  it('consumes every authorization after a successful batch', () => {
    const root = makeRoot()
    const first = join(root, 'first.pdf')
    const second = join(root, 'second.pdf')
    writeFileSync(first, 'pdf')
    writeFileSync(second, 'pdf')
    const capabilities = createRendererPathCapabilities()
    capabilities.authorizeFile(first)
    capabilities.authorizeFile(second)

    expect(capabilities.consumeFiles([first, second], ['.pdf'])).toEqual([
      realpathSync(first),
      realpathSync(second)
    ])
    expect(() => capabilities.consumeFile(first)).toThrow('not selected by the user')
    expect(() => capabilities.consumeFile(second)).toThrow('not selected by the user')
  })

  it('rejects duplicate paths in a batch without consuming the authorization', () => {
    const root = makeRoot()
    const file = join(root, 'paper.pdf')
    writeFileSync(file, 'pdf')
    const capabilities = createRendererPathCapabilities()
    capabilities.authorizeFile(file)

    expect(() => capabilities.consumeFiles([file, file], ['.pdf'])).toThrow(
      'A path authorization cannot be reused'
    )
    expect(capabilities.consumeFile(file, ['.pdf'])).toBe(realpathSync(file))
  })

  it('clears every authorization and its expiry timer', () => {
    vi.useFakeTimers()
    const root = makeRoot()
    const first = join(root, 'first.pdf')
    const second = join(root, 'second.pdf')
    writeFileSync(first, 'pdf')
    writeFileSync(second, 'pdf')
    const capabilities = createRendererPathCapabilities()
    capabilities.authorizeFile(first)
    capabilities.authorizeFile(second)

    expect(vi.getTimerCount()).toBe(2)
    capabilities.clear()

    expect(vi.getTimerCount()).toBe(0)
    expect(() => capabilities.consumeFile(first)).toThrow('not selected by the user')
    expect(() => capabilities.consumeFile(second)).toThrow('not selected by the user')
  })

  it('actively releases abandoned capabilities after their TTL', async () => {
    vi.useFakeTimers()
    const root = makeRoot()
    const file = join(root, 'abandoned.pdf')
    writeFileSync(file, 'pdf')
    const capabilities = createRendererPathCapabilities(50)

    capabilities.authorizeFile(file)
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(51)
    expect(vi.getTimerCount()).toBe(0)
    expect(() => capabilities.consumeFile(file)).toThrow('not selected by the user')
  })
})
