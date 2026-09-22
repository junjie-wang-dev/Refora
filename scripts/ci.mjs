import { spawn, execFileSync } from 'node:child_process'
import { createWriteStream, mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { finished } from 'node:stream/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { availableParallelism, release } from 'node:os'

export const fullStages = ['prepare', 'verify', 'audit', 'stability', 'database', 'e2e', 'package']
export function defaultArtifactsDirectory(root, stages) {
  return join(root, 'test-results', 'ci', stages.join('-'))
}

export function readToolchain(root) {
  const read = name => readFileSync(join(root, name), 'utf8').trim()
  return {
    node: read('.nvmrc'), npm: JSON.parse(read('package.json')).engines.npm,
    uv: read('.uv-version'), python: read('backend/.python-version'), postgres: read('.postgres-version')
  }
}

export function stagePlan(stages, versions, directory) {
  const requirements = join(directory, 'requirements.txt')
  const plans = {
    prepare: [
      ['npm', ['ci']],
      ['uv', ['sync', '--project', 'backend', '--locked', '--python', versions.python]],
      ['uv', ['run', '--project', 'backend', '--locked', 'python', '-c', `import platform; assert platform.python_version() == '${versions.python}', platform.python_version()`]]
    ],
    verify: [['npm', ['run', 'verify']]],
    audit: [
      ['npm', ['audit', '--audit-level=moderate']],
      ['uv', ['export', '--project', 'backend', '--locked', '--no-dev', '--no-emit-project', '--format', 'requirements-txt', '--output-file', requirements]],
      ['uvx', ['--python', versions.python, '--from', 'pip-audit==2.10.1', 'pip-audit', '-r', requirements, '--disable-pip', '--progress-spinner', 'off']]
    ],
    stability: Array.from({ length: 3 }, () => [
      ['npm', ['run', 'test', '--', 'tests/component/LobeControls.test.tsx', 'tests/component/LatexResourceDialog.test.tsx', 'tests/component/PdfReader.test.tsx']],
      ['uv', ['run', '--project', 'backend', '--locked', 'python', '-m', 'pytest', '-c', 'backend/pyproject.toml', 'backend/tests/test_watcher.py', '-k', 'debounce_waits or debounce_allows or stopping_cancels or imports_each_file_once']]
    ]).flat(),
    database: [['node', ['scripts/ci-database.mjs']]],
    e2e: [['npm', ['run', 'test:e2e:ci']]],
    package: [['npm', ['run', 'package', '--', '--publish', 'never']]]
  }
  return stages.flatMap(stage => {
    if (!Object.hasOwn(plans, stage)) throw new Error(`Unknown CI stage: ${stage}`)
    return plans[stage].map(([command, args], index) => ({ name: `${stage}-${index + 1}`, stage, command, args }))
  })
}

export function ciEnvironment(base, versions) {
  const env = { ...base, CI: 'true', TZ: 'UTC', PYTHONHASHSEED: '0', UV_PYTHON: versions.python, REFORA_CI: '1' }
  for (const key of ['NODE_OPTIONS', 'PYTHONPATH', 'PYTHONHOME', 'VIRTUAL_ENV', 'UV_PROJECT_ENVIRONMENT', 'ELECTRON_RUN_AS_NODE', 'PYTEST_ADDOPTS', 'PYTEST_PLUGINS']) delete env[key]
  return env
}

export async function executePlan(plan, { cwd, env, directory, metadata = {}, output = process.stdout }) {
  mkdirSync(directory, { recursive: true })
  const report = { ...metadata, startedAt: new Date().toISOString(), status: 'running', steps: plan.map(step => ({ ...step, status: 'not_run' })) }
  const save = () => writeFileSync(join(directory, 'result.json'), JSON.stringify(report, null, 2) + '\n')
  save()
  let active
  const interrupt = signal => {
    if (active?.pid) {
      try { process.kill(process.platform === 'win32' ? active.pid : -active.pid, signal) } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
  }
  const sigint = () => interrupt('SIGINT')
  const sigterm = () => interrupt('SIGTERM')
  process.on('SIGINT', sigint)
  process.on('SIGTERM', sigterm)
  try {
    for (const step of report.steps) {
      step.startedAt = new Date().toISOString()
      step.status = 'running'
      step.log = `${step.name}.log`
      save()
      output.write(`\n[CI] ${step.name}: ${step.command} ${step.args.join(' ')}\n`)
      const log = createWriteStream(join(directory, step.log))
      const began = performance.now()
      try {
        await new Promise((accept, reject) => {
          active = spawn(step.command, step.args, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
          for (const stream of [active.stdout, active.stderr]) stream.on('data', chunk => { log.write(chunk); output.write(chunk) })
          active.on('error', reject)
          active.on('close', (code, signal) => {
            step.exitCode = code
            step.signal = signal
            if (code === 0) accept()
            else reject(new Error(`${step.name} failed (${signal || code}); see ${join(directory, step.log)}`))
          })
        })
        step.status = 'passed'
      } catch (error) {
        step.status = 'failed'
        step.error = error.message
        throw error
      } finally {
        active = undefined
        step.durationMs = Math.round(performance.now() - began)
        log.end()
        await finished(log)
        if (['verify', 'stability'].includes(step.stage)) {
          for (const [source, suffix] of [[join(cwd, 'test-results/vitest.xml'), 'vitest'], [join(directory, 'backend.xml'), 'backend']]) {
            if (existsSync(source)) copyFileSync(source, join(directory, `${step.name}.${suffix}.xml`))
          }
        }
        save()
      }
    }
    report.status = 'passed'
  } catch (error) {
    report.status = 'failed'
    report.error = error.message
    throw error
  } finally {
    process.off('SIGINT', sigint)
    process.off('SIGTERM', sigterm)
    report.finishedAt = new Date().toISOString()
    save()
    const lines = ['# CI results', '', `Status: ${report.status}`, `Commit: ${report.commit || 'unknown'}`, '', '| Step | Result | Duration (ms) |', '| --- | --- | --- |', ...report.steps.map(s => `| ${s.name} | ${s.status} | ${s.durationMs ?? ''} |`)]
    writeFileSync(join(directory, 'summary.md'), lines.join('\n') + '\n')
    if (env.GITHUB_STEP_SUMMARY) writeFileSync(env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n', { flag: 'a' })
  }
  return report
}

export async function main(args = process.argv.slice(2)) {
  const cwd = process.cwd()
  const stages = args.length ? args : fullStages
  const versions = readToolchain(cwd)
  const directory = resolve(process.env.REFORA_CI_ARTIFACTS || defaultArtifactsDirectory(cwd, stages))
  const env = ciEnvironment(process.env, versions)
  env.REFORA_CI_ARTIFACTS = directory
  env.PYTEST_ADDOPTS = `--junitxml=${JSON.stringify(join(directory, 'backend.xml'))}`
  mkdirSync(directory, { recursive: true })
  const metadata = {
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim(),
    dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }).trim()),
    platform: process.platform, arch: process.arch, osRelease: release(), cpus: availableParallelism(),
    versions, stages, githubRun: env.GITHUB_RUN_ID || null,
    snapshot: existsSync(join(directory, 'snapshot.json')) ? JSON.parse(readFileSync(join(directory, 'snapshot.json'), 'utf8')) : null
  }
  writeFileSync(join(directory, 'environment.json'), JSON.stringify(metadata, null, 2) + '\n')
  try {
    const actual = {
      node: process.versions.node,
      npm: execFileSync('npm', ['--version'], { cwd, env, encoding: 'utf8' }).trim(),
      uv: execFileSync('uv', ['--version'], { cwd, env, encoding: 'utf8' }).trim().split(' ')[1]
    }
    metadata.actualTools = actual
    writeFileSync(join(directory, 'environment.json'), JSON.stringify(metadata, null, 2) + '\n')
    for (const key of ['node', 'npm', 'uv']) if (actual[key] !== versions[key]) throw new Error(`Expected ${key} ${versions[key]}, found ${actual[key]}`)
    if (stages.some(stage => ['e2e', 'package'].includes(stage)) && process.platform !== 'darwin') throw new Error('Electron E2E and packaging require macOS')
    return await executePlan(stagePlan(stages, versions, directory), { cwd, env, directory, metadata })
  } catch (error) {
    if (!existsSync(join(directory, 'result.json'))) writeFileSync(join(directory, 'result.json'), JSON.stringify({ ...metadata, status: 'failed', error: error.message }, null, 2) + '\n')
    throw error
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
