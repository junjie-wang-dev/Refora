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
    expect(script).toContain('/shutdown')
    expect(script).toContain("'langchain-openai'")
    expect(script).toContain("'langgraph-checkpoint-sqlite'")
  })

  it('uses separate native runners for arm64 and x64 packages', () => {
    for (const workflow of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) {
      const contents = readFileSync(workflow, 'utf8')

      expect(contents).toContain('arch: arm64')
      expect(contents).toContain('runner: macos-15')
      expect(contents).toContain('arch: x64')
      expect(contents).toContain('runner: macos-15-intel')
      expect(contents).toContain('REFORA_TARGET_ARCH: ${{ matrix.arch }}')
    }
  })
})
