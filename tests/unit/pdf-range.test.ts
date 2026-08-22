import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_PDF_RANGE_BYTES,
  readPdfFileRange
} from '../../src/main/services/pdfRange'

const temporaryDirectories: string[] = []

async function fixture(contents = '%PDF-streamed-content'): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'refora-pdf-range-'))
  temporaryDirectories.push(directory)
  const path = join(directory, 'paper.pdf')
  await writeFile(path, contents)
  return path
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

describe('PDF range reader', () => {
  it('reads only the requested bytes and reports the stable file size', async () => {
    const filePath = await fixture('0123456789')

    const result = await readPdfFileRange(filePath, 2, 6)

    expect(result.begin).toBe(2)
    expect(result.fileSize).toBe(10)
    expect(new TextDecoder().decode(result.data)).toBe('2345')
  })

  it('clamps the final range to the end of the file', async () => {
    const filePath = await fixture('0123456789')

    const result = await readPdfFileRange(filePath, 7, 100)

    expect(new TextDecoder().decode(result.data)).toBe('789')
  })

  it('rejects invalid and oversized ranges', async () => {
    const filePath = await fixture()

    await expect(readPdfFileRange(filePath, -1, 10)).rejects.toMatchObject({
      code: 'invalid_range'
    })
    await expect(readPdfFileRange(filePath, 0, MAX_PDF_RANGE_BYTES + 1)).rejects.toMatchObject({
      code: 'invalid_range'
    })
    await expect(readPdfFileRange(filePath, 100, 101)).rejects.toMatchObject({
      code: 'invalid_range'
    })
  })

  it('preserves absolute PDF, regular-file, and non-symlink validation', async () => {
    const filePath = await fixture()
    const directory = temporaryDirectories.at(-1)!
    const linkPath = join(directory, 'linked.pdf')
    await symlink(filePath, linkPath)

    await expect(readPdfFileRange('relative.pdf', 0, 1)).rejects.toThrow(
      'PDF path must be absolute'
    )
    await expect(readPdfFileRange(linkPath, 0, 1)).rejects.toThrow(
      'regular PDF file'
    )
  })
})
