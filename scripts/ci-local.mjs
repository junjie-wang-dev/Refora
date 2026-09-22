import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, cpSync, readdirSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyWorkingTree, snapshotHash } from './ci-snapshot.mjs'

const source = process.cwd()
const args = process.argv.slice(2)
const workingTree = args.includes('--working-tree')
if (args.some(arg => arg !== '--working-tree')) throw new Error('Usage: npm run ci:local -- [--working-tree]')
const git = (...params) => execFileSync('git', params, { cwd: source, encoding: 'utf8' })
const status = git('status', '--porcelain')
if (status.trim() && !workingTree) throw new Error('Commit checkout is dirty. Use --working-tree to validate an explicitly labelled snapshot of current non-ignored files.')
const root = mkdtempSync(join(tmpdir(), 'refora-ci-'))
const checkout = join(root, 'checkout')
const directory = join(source, 'test-results', 'ci', `local-${new Date().toISOString().replaceAll(':', '-')}`)
mkdirSync(directory, { recursive: true })
console.log(`Isolated checkout: ${checkout}\nEvidence: ${directory}`)
let passed = false
try {
  execFileSync('git', ['clone', '--local', '--no-hardlinks', '--no-checkout', source, checkout], { stdio: 'inherit' })
  execFileSync('git', ['checkout', '--detach', git('rev-parse', 'HEAD').trim()], { cwd: checkout, stdio: 'inherit' })
  if (workingTree) copyWorkingTree(source, checkout)
  const sha256 = await snapshotHash(checkout)
  writeFileSync(join(directory, 'snapshot.json'), JSON.stringify({ commit: git('rev-parse', 'HEAD').trim(), kind: workingTree ? 'working-tree' : 'commit', sha256, checkout }, null, 2) + '\n')
  const code = await new Promise((accept, reject) => {
    const child = spawn(process.execPath, ['scripts/ci.mjs'], { cwd: checkout, stdio: 'inherit', env: { ...process.env, REFORA_CI_ARTIFACTS: directory, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } })
    const stop = signal => child.kill(signal)
    const sigint = () => stop('SIGINT')
    const sigterm = () => stop('SIGTERM')
    process.on('SIGINT', sigint)
    process.on('SIGTERM', sigterm)
    child.once('error', reject)
    child.once('close', code => { process.off('SIGINT', sigint); process.off('SIGTERM', sigterm); accept(code ?? 1) })
  })
  for (const name of ['test-results', 'playwright-report', 'coverage']) {
    if (existsSync(join(checkout, name))) cpSync(join(checkout, name), join(directory, name), { recursive: true })
  }
  if (existsSync(join(checkout, 'dist'))) {
    for (const name of readdirSync(join(checkout, 'dist')).filter(name => name.endsWith('.dmg'))) {
      mkdirSync(join(directory, 'packages'), { recursive: true })
      copyFileSync(join(checkout, 'dist', name), join(directory, 'packages', name))
    }
  }
  passed = code === 0
  process.exitCode = code
} finally {
  if (passed) rmSync(root, { recursive: true, force: true })
  else console.error(`Failed checkout preserved at ${checkout}`)
  console.log(`CI evidence: ${directory}`)
}
