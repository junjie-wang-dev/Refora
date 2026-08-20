import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const supportedCliVersion = '2.115.0'
const args = process.argv.slice(2)
const signature = args.join(' ')
const commands = new Map([
  ['migration list', { readOnly: false }],
  ['db push --dry-run', { readOnly: false }],
  ['db push', { readOnly: false }],
  ['test rpc', { readOnly: false }]
])
const command = commands.get(signature)

if (process.platform !== 'darwin') {
  throw new Error('Supabase remote migrations are configured for macOS Keychain')
}

if (!command) {
  throw new Error('Use migration list, db push --dry-run, db push, or test rpc')
}

const cliVersion = spawnSync('supabase', ['--version'], { encoding: 'utf8' })
if (cliVersion.error || cliVersion.status !== 0) {
  throw new Error('Install Supabase CLI 2.115.0 before managing remote migrations')
}
if (cliVersion.stdout.trim() !== supportedCliVersion) {
  throw new Error(
    `Supabase CLI ${supportedCliVersion} is required; found ${cliVersion.stdout.trim() || 'unknown'}`
  )
}

const projectRefPath = fileURLToPath(new URL('../supabase/.temp/project-ref', import.meta.url))
const poolerUrlPath = fileURLToPath(new URL('../supabase/.temp/pooler-url', import.meta.url))
if (!existsSync(projectRefPath) || !existsSync(poolerUrlPath)) {
  throw new Error('Run supabase link --project-ref PROJECT_REF before managing remote migrations')
}
const projectRef = readFileSync(projectRefPath, 'utf8').trim()
const poolerUrl = new URL(readFileSync(poolerUrlPath, 'utf8').trim())
const keychain = spawnSync(
  'security',
  ['find-generic-password', '-s', 'Supabase CLI', '-a', 'supabase', '-w'],
  { encoding: 'utf8' }
)

if (keychain.status !== 0 || !keychain.stdout.trim()) {
  throw new Error('Run supabase login before managing remote migrations')
}

const loginRole = spawnSync('curl', ['--config', '-'], {
  encoding: 'utf8',
  input: [
    `url = "https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef)}/cli/login-role"`,
    'request = "POST"',
    'header = "Accept: application/json"',
    `header = "Authorization: Bearer ${keychain.stdout.trim()}"`,
    'header = "Content-Type: application/json"',
    `data = "{\\"read_only\\":${command.readOnly ? 'true' : 'false'}}"`,
    'fail-with-body',
    'silent',
    'show-error'
  ].join('\n')
})

if (loginRole.status !== 0) {
  throw new Error('Supabase temporary database role request failed')
}

let credentials
try {
  credentials = JSON.parse(loginRole.stdout)
} catch {
  throw new Error('Supabase returned malformed temporary database credentials')
}

if (typeof credentials.role !== 'string' || typeof credentials.password !== 'string') {
  throw new Error('Supabase returned invalid temporary database credentials')
}

poolerUrl.username = `${credentials.role}.${projectRef}`
poolerUrl.password = ''
poolerUrl.port = '6543'
poolerUrl.searchParams.set('sslmode', 'require')

const result = signature === 'test rpc'
  ? spawnSync(
      'uv',
      ['run', '--project', 'backend', '--locked', 'python', 'scripts/test-supabase-rpc.py'],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          REFORA_SUPABASE_TEST_DB_URL: poolerUrl.toString(),
          REFORA_SUPABASE_TEST_DB_PASSWORD: credentials.password
        }
      }
    )
  : spawnSync(
      'supabase',
      ['--agent', 'no', '--output-format', 'text', ...args, '--db-url', poolerUrl.toString()],
      {
        stdio: 'inherit',
        env: { ...process.env, PGPASSWORD: credentials.password }
      }
    )

if (result.error) throw new Error(`Unable to run Supabase CLI: ${result.error.message}`)
process.exit(result.status ?? 1)
