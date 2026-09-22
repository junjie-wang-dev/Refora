import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { copyWorkingTree, snapshotHash } from '../../scripts/ci-snapshot.mjs'

function repository(root, name) {
  const path = join(root, name)
  mkdirSync(path)
  execFileSync('git', ['init', '-q', path])
  return path
}

test('working-tree snapshot includes edits and new files, respects deletions and excludes local state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'refora-snapshot-test-'))
  try {
    const source = repository(root, 'source')
    const target = repository(root, 'target')
    for (const path of [source, target]) {
      writeFileSync(join(path, '.gitignore'), 'node_modules/\nbackend/.venv/\n.env.local\nout/\n')
      writeFileSync(join(path, 'tracked.txt'), 'old')
      writeFileSync(join(path, 'removed.txt'), 'old')
      execFileSync('git', ['add', '.'], { cwd: path })
    }
    writeFileSync(join(source, 'tracked.txt'), 'new')
    execFileSync('git', ['rm', '-q', '--cached', 'removed.txt'], { cwd: source })
    rmSync(join(source, 'removed.txt'))
    writeFileSync(join(source, 'new.txt'), 'new file')
    writeFileSync(join(source, '.env.local'), 'private local settings')
    for (const directory of ['node_modules', 'backend/.venv', 'out']) {
      mkdirSync(join(source, directory), { recursive: true })
      writeFileSync(join(source, directory, 'stale.txt'), 'stale')
    }
    copyWorkingTree(source, target)
    assert.equal(readFileSync(join(target, 'tracked.txt'), 'utf8'), 'new')
    assert.equal(readFileSync(join(target, 'new.txt'), 'utf8'), 'new file')
    for (const file of ['removed.txt', '.env.local', 'node_modules', 'backend/.venv', 'out']) assert.equal(existsSync(join(target, file)), false)
    const first = await snapshotHash(target)
    assert.equal(first, await snapshotHash(target))
    writeFileSync(join(target, 'tracked.txt'), 'changed again')
    assert.notEqual(first, await snapshotHash(target))
    assert.equal(readFileSync(join(source, 'tracked.txt'), 'utf8'), 'new')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('snapshot rejects symlinks to dependencies outside the isolated checkout', () => {
  const root = mkdtempSync(join(tmpdir(), 'refora-snapshot-link-'))
  try {
    const source = repository(root, 'source')
    const target = repository(root, 'target')
    symlinkSync('../outside', join(source, 'linked'))
    assert.throws(() => copyWorkingTree(source, target), /escapes checkout/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
