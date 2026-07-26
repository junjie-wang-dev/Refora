import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'

const runFile = promisify(execFile)

export async function architectures(executable) {
  const { stdout } = await runFile('/usr/bin/lipo', ['-archs', executable])
  return stdout.trim().split(/\s+/).filter(Boolean)
}

export async function canonicalSha256(executable) {
  const directory = await mkdtemp(join(tmpdir(), 'refora-sidecar-integrity-'))
  const copy = join(directory, basename(executable))
  try {
    await copyFile(executable, copy)
    await runFile('/usr/bin/codesign', ['--remove-signature', copy]).catch(() => undefined)
    return createHash('sha256').update(await readFile(copy)).digest('hex')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
