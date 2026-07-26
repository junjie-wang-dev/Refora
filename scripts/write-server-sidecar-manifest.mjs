import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalSha256 } from './server-sidecar-integrity.mjs'

const [outputDirectory, architecture, pythonVersion] = process.argv.slice(2)
if (!outputDirectory || !['arm64', 'x64'].includes(architecture) || !pythonVersion) {
  throw new Error(
    'Usage: write-server-sidecar-manifest.mjs <directory> <arm64|x64> <python-version>'
  )
}

const executable = join(outputDirectory, 'refora-server')
const digest = await canonicalSha256(executable)
const manifest = {
  formatVersion: 1,
  platform: 'darwin',
  architecture,
  pythonVersion,
  executable: 'refora-server',
  canonicalSha256: digest
}
await writeFile(
  join(outputDirectory, 'sidecar-manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  { mode: 0o644 }
)
