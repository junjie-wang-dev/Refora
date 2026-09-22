import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'

const version = readFileSync('.postgres-version', 'utf8').trim()
const env = { ...process.env, REFORA_SUPABASE_TEST_SSL: 'false', REFORA_SUPABASE_TEST_POSTGRES_VERSION: version }
const artifacts = resolve(env.REFORA_CI_ARTIFACTS || 'test-results/ci/database')
mkdirSync(artifacts, { recursive: true })
let cleanup = () => {}
let cleaned = false
const dispose = () => { if (!cleaned) { cleaned = true; cleanup() } }
process.once('SIGINT', () => { dispose(); process.exit(130) })
process.once('SIGTERM', () => { dispose(); process.exit(143) })
const run = (command, args, options = {}) => execFileSync(command, args, { env, stdio: 'inherit', ...options })
const port = async () => {
  const server = createServer()
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept) })
  const selected = server.address().port
  await new Promise(accept => server.close(accept))
  return selected
}
try {
  if (!env.REFORA_SUPABASE_TEST_DB_URL) {
    const selectedPort = await port()
    env.REFORA_SUPABASE_TEST_DB_URL = `postgresql://postgres@127.0.0.1:${selectedPort}/refora_sync_test`
    env.REFORA_SUPABASE_TEST_DB_PASSWORD = randomUUID()
    if (env.REFORA_POSTGRES_BIN) {
      const bin = resolve(env.REFORA_POSTGRES_BIN)
      const actual = execFileSync(join(bin, 'postgres'), ['--version'], { encoding: 'utf8' }).trim().split(' ').at(-1)
      if (actual !== version) throw new Error(`Expected PostgreSQL ${version}, found ${actual}`)
      const root = mkdtempSync(join(tmpdir(), 'refora-postgres-'))
      const data = join(root, 'data')
      const password = join(root, 'password')
      const log = join(artifacts, 'postgres.log')
      writeFileSync(password, env.REFORA_SUPABASE_TEST_DB_PASSWORD, { mode: 0o600 })
      let started = false
      cleanup = () => {
        if (started) run(join(bin, 'pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop'])
        rmSync(root, { recursive: true, force: true })
      }
      run(join(bin, 'initdb'), ['-D', data, '-U', 'postgres', '--auth=scram-sha-256', `--pwfile=${password}`, '--encoding=UTF8', '--locale=C'])
      run(join(bin, 'pg_ctl'), ['-D', data, '-l', log, '-o', `-h 127.0.0.1 -p ${selectedPort} -k ${root}`, '-w', 'start'])
      started = true
      run(join(bin, 'createdb'), ['-h', '127.0.0.1', '-p', String(selectedPort), '-U', 'postgres', 'refora_sync_test'], { env: { ...env, PGPASSWORD: env.REFORA_SUPABASE_TEST_DB_PASSWORD } })
    } else {
      const docker = spawnSync('docker', ['info'], { stdio: 'ignore' })
      if (docker.status !== 0) throw new Error(`Database gate requires Docker or REFORA_POSTGRES_BIN pointing to PostgreSQL ${version} binaries. No gate was skipped.`)
      const name = `refora-ci-${randomUUID()}`
      cleanup = () => {
        const logs = spawnSync('docker', ['logs', name], { encoding: 'utf8' })
        writeFileSync(join(artifacts, 'postgres.log'), (logs.stdout || '') + (logs.stderr || ''))
        run('docker', ['rm', '-f', name])
      }
      run('docker', ['run', '--detach', '--name', name, '-p', `127.0.0.1:${selectedPort}:5432`, '-e', 'POSTGRES_DB=refora_sync_test', '-e', 'POSTGRES_USER=postgres', '-e', 'POSTGRES_PASSWORD', '--health-cmd', 'pg_isready -U postgres -d refora_sync_test', '--health-interval', '1s', '--health-retries', '60', `postgres:${version}-bookworm`], { env: { ...env, POSTGRES_PASSWORD: env.REFORA_SUPABASE_TEST_DB_PASSWORD } })
      const deadline = Date.now() + 90000
      while (true) {
        const status = execFileSync('docker', ['inspect', '--format', '{{.State.Health.Status}}', name], { encoding: 'utf8' }).trim()
        if (status === 'healthy') break
        if (status === 'unhealthy' || Date.now() > deadline) throw new Error(`PostgreSQL readiness failed: ${status}`)
        await new Promise(accept => setTimeout(accept, 500))
      }
    }
  }
  run('uv', ['run', '--project', 'backend', '--locked', 'python', 'scripts/test-supabase-local.py'])
} finally {
  dispose()
}
