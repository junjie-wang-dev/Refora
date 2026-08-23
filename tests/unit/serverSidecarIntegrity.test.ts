import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canonicalTreeSha256 } from '../../scripts/server-sidecar-integrity.mjs'

describe('server sidecar tree integrity', () => {
  it('covers internal dependencies while excluding the manifest itself', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'refora-sidecar-tree-'))
    try {
      const internal = join(directory, '_internal')
      mkdirSync(internal)
      writeFileSync(join(directory, 'refora-server'), 'executable')
      writeFileSync(join(internal, 'dependency.py'), 'first')
      writeFileSync(join(directory, 'sidecar-manifest.json'), '{}')
      const initial = await canonicalTreeSha256(directory)

      writeFileSync(join(directory, 'sidecar-manifest.json'), '{"changed":true}')
      await expect(canonicalTreeSha256(directory)).resolves.toBe(initial)

      writeFileSync(join(internal, 'dependency.py'), 'second')
      await expect(canonicalTreeSha256(directory)).resolves.not.toBe(initial)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
