import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, lstatSync, readlinkSync, mkdirSync, copyFileSync, symlinkSync, rmSync, chmodSync } from 'node:fs'
import { resolve, join, dirname, isAbsolute, relative } from 'node:path'

function filesAt(directory, args) {
  return [...new Set(execFileSync('git', ['ls-files', ...args, '-z'], { cwd: directory, encoding: 'utf8' }).split('\0').filter(Boolean))].sort()
}

export function copyWorkingTree(source, checkout) {
  for (const file of filesAt(checkout, [])) rmSync(join(checkout, file), { force: true })
  for (const file of filesAt(source, ['--cached', '--others', '--exclude-standard'])) {
    let stat
    try { stat = lstatSync(join(source, file)) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    const target = join(checkout, file)
    mkdirSync(dirname(target), { recursive: true })
    if (stat.isSymbolicLink()) {
      const link = readlinkSync(join(source, file))
      if (isAbsolute(link) || relative(checkout, resolve(dirname(target), link)).startsWith('..')) throw new Error(`Snapshot symlink escapes checkout: ${file}`)
      symlinkSync(link, target)
    } else if (stat.isFile()) {
      copyFileSync(join(source, file), target)
      chmodSync(target, stat.mode)
    } else throw new Error(`Unsupported snapshot entry: ${file}`)
  }
}

export async function snapshotHash(checkout) {
  const hash = createHash('sha256')
  for (const file of filesAt(checkout, ['--cached', '--others', '--exclude-standard'])) {
    let stat
    try { stat = lstatSync(join(checkout, file)) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    hash.update(`${file}\0${stat.mode}\0`)
    if (stat.isSymbolicLink()) hash.update(readlinkSync(join(checkout, file)))
    else if (stat.isFile()) for await (const chunk of createReadStream(join(checkout, file))) hash.update(chunk)
    else throw new Error(`Unsupported snapshot entry: ${file}`)
    hash.update('\0')
  }
  return hash.digest('hex')
}
