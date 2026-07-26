import { constants } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  architectures,
  canonicalSha256
} from './server-sidecar-integrity.mjs'

const [applicationPath, expectedArchitecture] = process.argv.slice(2)
if (!applicationPath || !['arm64', 'x64'].includes(expectedArchitecture)) {
  throw new Error('Usage: verify-packaged-sidecar.mjs <app> <arm64|x64>')
}

const sidecarDirectory = join(applicationPath, 'Contents', 'Resources', 'python-server')
const executable = join(sidecarDirectory, 'refora-server')
await access(executable, constants.X_OK)
const manifest = JSON.parse(
  await readFile(join(sidecarDirectory, 'sidecar-manifest.json'), 'utf8')
)
if (manifest.architecture !== expectedArchitecture) {
  throw new Error(
    `Packaged sidecar architecture ${manifest.architecture} does not match ${expectedArchitecture}`
  )
}
const expectedMachArchitecture = expectedArchitecture === 'x64' ? 'x86_64' : 'arm64'
const binaryArchitectures = await architectures(executable)
if (
  binaryArchitectures.length !== 1 ||
  binaryArchitectures[0] !== expectedMachArchitecture
) {
  throw new Error(
    `Packaged sidecar binary architecture ${binaryArchitectures.join(',')} does not match ${expectedMachArchitecture}`
  )
}
const digest = await canonicalSha256(executable)
if (manifest.canonicalSha256 !== digest) {
  throw new Error('Packaged sidecar checksum does not match its manifest')
}
