import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Python server packaging', () => {
  it('packages only the native sidecar and identifies artifacts by architecture', () => {
    const configuration = readFileSync('electron-builder.yml', 'utf8')

    expect(configuration).toContain('from: build/python-server')
    expect(configuration).toContain('Contents/Resources/python-server/refora-server')
    expect(configuration).toContain('${productName}-${version}-${arch}.${ext}')
    expect(configuration).not.toContain('agent-python')
    expect(configuration).not.toContain('agent-runner')
  })

  it('builds the sidecar from the locked Python server project', () => {
    const script = readFileSync('scripts/build-server-sidecar.sh', 'utf8')

    expect(script).toContain('PROJECT_DIR="$ROOT_DIR/backend"')
    expect(script).toContain('--project "$PROJECT_DIR"')
    expect(script).toContain('--locked')
    expect(script).toContain('pyinstaller')
    expect(script).toContain('TARGET_ARCH')
    expect(script).toContain('HOST_ARCH')
    expect(script).toContain('--collect-all langchain_openai')
    expect(script).toContain('--collect-all langgraph.checkpoint.sqlite')
    expect(script).toContain('--collect-all refora_server')
    expect(script).toContain('refora_server/mineru_runtime:refora_server/mineru_runtime')
    expect(script).toContain('--copy-metadata langchain-openai')
    expect(script).toContain('--copy-metadata langgraph-checkpoint-sqlite')
    expect(script).toContain('verify-server-sidecar.mjs')
    expect(script).not.toContain('src/main/db')
  })

  it('packages backend workers from the backend boundary', () => {
    const configuration = readFileSync('electron-builder.yml', 'utf8')

    expect(configuration).toContain('from: backend/workers/mineru_worker.py')
    expect(configuration).not.toContain('from: resources/')
  })

  it('runs offline artifact and server startup smoke checks', () => {
    const script = readFileSync('scripts/verify-server-sidecar.mjs', 'utf8')

    expect(script).toContain("['--verify-artifact']")
    expect(script).toContain('/ready')
    expect(script).toContain("child.kill('SIGTERM')")
    expect(script).toContain("result.signal !== 'SIGTERM'")
    expect(script).toContain("'langchain-openai'")
    expect(script).toContain("'langgraph-checkpoint-sqlite'")
  })

  it('repeats artifact and readiness checks against the final packaged app', () => {
    const verifier = readFileSync('scripts/verify-packaged-sidecar.mjs', 'utf8')
    const packageScript = readFileSync('scripts/package-macos.sh', 'utf8')
    const manifestWriter = readFileSync('scripts/write-server-sidecar-manifest.mjs', 'utf8')
    const sidecarVerifier = readFileSync('scripts/verify-server-sidecar.mjs', 'utf8')

    expect(verifier).toContain("new URL('./verify-server-sidecar.mjs'")
    expect(verifier).toContain("join(applicationPath, 'Contents', 'Resources', 'python-server')")
    expect(manifestWriter).toContain('canonicalTreeSha256')
    expect(sidecarVerifier).toContain('Sidecar dependency tree checksum mismatch')
    expect(packageScript).toContain('verify-packaged-sidecar.mjs')
    expect(packageScript.indexOf('electron-builder')).toBeLessThan(
      packageScript.indexOf('verify-packaged-sidecar.mjs')
    )
  })

  it('packages only for Apple Silicon on native runners', () => {
    for (const workflow of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) {
      const contents = readFileSync(workflow, 'utf8')

      expect(contents).toContain('arch: arm64')
      expect(contents).toContain('runner: macos-15')
      expect(contents).not.toContain('arch: x64')
      expect(contents).not.toContain('runner: macos-15-intel')
      expect(contents).toContain('REFORA_TARGET_ARCH: ${{ matrix.arch }}')
    }
  })
})
