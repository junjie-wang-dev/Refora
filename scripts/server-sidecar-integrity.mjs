import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { copyFile, lstat, mkdtemp, readFile, readdir, readlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'
import { promisify } from 'node:util'

const runFile = promisify(execFile)

export async function architectures(executable) {
  const { stdout } = await runFile('/usr/bin/lipo', ['-archs', executable])
  return stdout.trim().split(/\s+/).filter(Boolean)
}

export async function canonicalSha256(executable) {
  const contents = await readFile(executable)
  const magic = contents.subarray(0, 4).toString('hex')
  if (!new Set([
    'feedface',
    'feedfacf',
    'cefaedfe',
    'cffaedfe',
    'cafebabe',
    'cafebabf',
    'bebafeca',
    'bfbafeca'
  ]).has(magic)) {
    return createHash('sha256').update(contents).digest('hex')
  }
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

export async function canonicalTreeSha256(directory) {
  const records = []

  async function visit(path) {
    const names = (await readdir(path)).sort()
    for (const name of names) {
      const child = join(path, name)
      const childPath = relative(directory, child)
      if (childPath === 'sidecar-manifest.json') continue
      const details = await lstat(child)
      if (details.isSymbolicLink()) {
        records.push(['link', childPath, await readlink(child)])
      } else if (details.isDirectory()) {
        records.push(['directory', childPath])
        await visit(child)
      } else if (details.isFile()) {
        records.push(['file', childPath, await canonicalSha256(child)])
      } else {
        throw new Error(`Unsupported sidecar artifact entry: ${child}`)
      }
    }
  }

  await visit(directory)
  return createHash('sha256').update(JSON.stringify(records)).digest('hex')
}
