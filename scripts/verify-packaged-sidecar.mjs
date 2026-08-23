import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const [applicationPath, expectedArchitecture] = process.argv.slice(2)
if (!applicationPath || !['arm64', 'x64'].includes(expectedArchitecture)) {
  throw new Error('Usage: verify-packaged-sidecar.mjs <app> <arm64|x64>')
}

const sidecarDirectory = join(applicationPath, 'Contents', 'Resources', 'python-server')
const verifier = fileURLToPath(new URL('./verify-server-sidecar.mjs', import.meta.url))
const runFile = promisify(execFile)
const { stdout, stderr } = await runFile(
  process.execPath,
  [verifier, sidecarDirectory, expectedArchitecture],
  {
    timeout: 120_000,
    maxBuffer: 2 * 1024 * 1024
  }
)
if (stdout) process.stdout.write(stdout)
if (stderr) process.stderr.write(stderr)
