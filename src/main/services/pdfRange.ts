import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import type { PdfRangeChunk } from '../../shared/ipc-types'
import { MainProcessError } from './errors'
import { resolvePdfFilePath } from './pdfPath'

export const MAX_PDF_RANGE_BYTES = 1024 * 1024

export async function readPdfFileRange(
  rawPath: string,
  begin: number,
  end: number
): Promise<PdfRangeChunk> {
  if (
    !Number.isSafeInteger(begin) ||
    !Number.isSafeInteger(end) ||
    begin < 0 ||
    end <= begin ||
    end - begin > MAX_PDF_RANGE_BYTES
  ) {
    throw new MainProcessError('invalid_range', 'Invalid PDF byte range')
  }

  const filePath = resolvePdfFilePath(rawPath)
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) {
      throw new MainProcessError('invalid_path', 'Selected path must be a regular PDF file')
    }
    if (begin >= stats.size) {
      throw new MainProcessError('invalid_range', 'PDF byte range is outside the file')
    }

    const length = Math.min(end, stats.size) - begin
    const data = new Uint8Array(length)
    let offset = 0
    while (offset < length) {
      const { bytesRead } = await handle.read(
        data,
        offset,
        length - offset,
        begin + offset
      )
      if (bytesRead === 0) break
      offset += bytesRead
    }
    return {
      begin,
      fileSize: stats.size,
      data: offset === data.length ? data : data.slice(0, offset)
    }
  } finally {
    await handle.close().catch(() => undefined)
  }
}
