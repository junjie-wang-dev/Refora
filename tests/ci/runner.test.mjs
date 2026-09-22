import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { executePlan, stagePlan, fullStages, ciEnvironment, readToolchain } from '../../scripts/ci.mjs'

const silent = () => new Writable({ write(_chunk, _encoding, done) { done() } })
const command = (name, code) => ({ name, stage: 'test', command: process.execPath, args: ['-e', code] })

test('a failed command stops the pipeline and keeps output and unrun gates', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'refora-ci-test-'))
  try {
    const plan = [command('pass', 'console.log("first gate")'), command('fail', 'console.error("diagnostic evidence"); process.exit(7)'), command('later', 'throw new Error("must not run")')]
    await assert.rejects(executePlan(plan, { cwd: process.cwd(), env: process.env, directory, output: silent() }), /fail failed \(7\)/)
    const report = JSON.parse(readFileSync(join(directory, 'result.json')))
    assert.equal(report.status, 'failed')
    assert.deepEqual(report.steps.map(s => s.status), ['passed', 'failed', 'not_run'])
    assert.equal(report.steps[1].exitCode, 7)
    assert.match(readFileSync(join(directory, 'fail.log'), 'utf8'), /diagnostic evidence/)
    assert.equal(existsSync(join(directory, 'later.log')), false)
    assert.match(readFileSync(join(directory, 'summary.md'), 'utf8'), /later \| not_run/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('missing executables produce a failure report rather than false success', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'refora-ci-missing-'))
  try {
    await assert.rejects(executePlan([{ name: 'missing', command: '/nonexistent-refora-ci-command', args: [] }], { cwd: process.cwd(), env: process.env, directory, output: silent() }))
    assert.equal(JSON.parse(readFileSync(join(directory, 'result.json'))).status, 'failed')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('shared stages include every gate and preserve fixed audit and package policies', () => {
  const versions = readToolchain(process.cwd())
  const plan = stagePlan(fullStages, versions, '/tmp/artifacts')
  assert.deepEqual([...new Set(plan.map(s => s.stage))], ['prepare', 'verify', 'audit', 'stability', 'database', 'e2e', 'package'])
  assert.ok(plan.some(s => s.command === 'npm' && s.args.join(' ') === 'ci'))
  assert.ok(plan.some(s => s.command === 'npm' && s.args.join(' ') === 'run verify'))
  assert.ok(plan.some(s => s.args.join(' ') === 'audit --audit-level=moderate'))
  assert.ok(plan.some(s => s.args.join(' ').includes('pip-audit==2.10.1')))
  assert.ok(plan.some(s => s.args.join(' ') === 'run package -- --publish never'))
  assert.equal(plan.filter(s => s.stage === 'stability').length, 6)
  assert.throws(() => stagePlan(['missing'], versions, '/tmp'), /Unknown CI stage/)
})

test('CI environment prevents inherited interpreter and Node overrides', () => {
  const actual = ciEnvironment({ PATH: '/bin', NODE_OPTIONS: '--require local.js', PYTHONPATH: '/local', PYTHONHOME: '/local', VIRTUAL_ENV: '/local', UV_PROJECT_ENVIRONMENT: '/local', ELECTRON_RUN_AS_NODE: '1', TZ: 'America/New_York', PYTEST_ADDOPTS: '--ignore=backend/tests', PYTEST_PLUGINS: 'local_plugin' }, { python: '3.12.13' })
  assert.equal(actual.PATH, '/bin')
  assert.equal(actual.CI, 'true')
  assert.equal(actual.TZ, 'UTC')
  assert.equal(actual.UV_PYTHON, '3.12.13')
  for (const key of ['NODE_OPTIONS', 'PYTHONPATH', 'PYTHONHOME', 'VIRTUAL_ENV', 'UV_PROJECT_ENVIRONMENT', 'ELECTRON_RUN_AS_NODE', 'PYTEST_ADDOPTS', 'PYTEST_PLUGINS']) assert.equal(actual[key], undefined)
})

test('GitHub invokes shared gates, retains failures, and requires aggregate success', () => {
  const quality = readFileSync('.github/workflows/quality.yml', 'utf8')
  for (const invocation of ['prepare verify audit stability', 'prepare e2e', 'database']) assert.ok(quality.includes(`run: npm run ci:stage -- ${invocation}`))
  assert.equal((quality.match(/if: always\(\)/g) || []).length, 3)
  assert.ok(quality.includes(`image: postgres:${readFileSync('.postgres-version', 'utf8').trim()}-bookworm`))
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8')
  assert.match(ci, /merge_group:/)
  assert.match(ci, /name: CI Ready\n {4}if: always\(\)\n {4}needs: \[quality, package\]/)
  assert.ok(ci.includes('test "$QUALITY_RESULT" = success'))
  assert.ok(ci.includes('test "$PACKAGE_RESULT" = success'))
  for (const file of ['ci.yml', 'release.yml']) assert.ok(readFileSync(`.github/workflows/${file}`, 'utf8').includes('run: npm run ci:stage -- package'))
})


test('terminated commands fail and do not advance to later gates', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'refora-ci-signal-'))
  try {
    await assert.rejects(executePlan([
      command('interrupted', 'process.kill(process.pid, "SIGTERM")'),
      command('later', 'process.exit(0)')
    ], { cwd: process.cwd(), env: process.env, directory, output: silent() }), /SIGTERM/)
    const report = JSON.parse(readFileSync(join(directory, 'result.json')))
    assert.equal(report.status, 'failed')
    assert.equal(report.steps[0].signal, 'SIGTERM')
    assert.equal(report.steps[1].status, 'not_run')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
