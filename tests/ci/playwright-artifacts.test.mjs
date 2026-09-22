import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Writable } from 'node:stream'
import { defaultArtifactsDirectory, executePlan } from '../../scripts/ci.mjs'

test('Playwright cleanup preserves colocated CI reports and open command logs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'refora-playwright-artifacts-'))
  const directory = defaultArtifactsDirectory(root, ['prepare', 'e2e'])
  try {
    mkdirSync(join(root, 'specs'), { recursive: true })
    mkdirSync(join(root, 'test-results', 'playwright'), { recursive: true })
    writeFileSync(join(root, 'test-results', 'playwright', 'stale.txt'), 'previous run')
    writeFileSync(join(root, 'playwright.config.ts'), `import base from ${JSON.stringify(resolve('playwright.config.ts'))};
export default { ...base, testDir: './specs', reporter: 'list', projects: [{ name: 'cleanup-probe' }] };
`)
    writeFileSync(join(root, 'specs', 'cleanup.spec.ts'), `import { test } from ${JSON.stringify(resolve('node_modules/@playwright/test/index.js'))};
test('runs after output cleanup', () => { console.log('cleanup probe completed'); });
`)
    const report = await executePlan([{
      name: 'e2e-1', stage: 'e2e', command: process.execPath,
      args: [resolve('node_modules/@playwright/test/cli.js'), 'test', '--config', join(root, 'playwright.config.ts'), '--workers=1']
    }], { cwd: root, env: { ...process.env, CI: 'true' }, directory, output: new Writable({ write(_chunk, _encoding, done) { done() } }) })
    assert.equal(report.status, 'passed')
    assert.equal(JSON.parse(readFileSync(join(directory, 'result.json'))).status, 'passed')
    assert.match(readFileSync(join(directory, 'e2e-1.log'), 'utf8'), /cleanup probe completed/)
    assert.match(readFileSync(join(directory, 'summary.md'), 'utf8'), /Status: passed/)
    assert.equal(existsSync(join(root, 'test-results', 'playwright', 'stale.txt')), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
