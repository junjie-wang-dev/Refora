import { describe, expect, it } from 'vitest'
import { proxyRulesForRuntime } from '../../src/shared/proxy'

describe('runtime proxy normalization', () => {
  it.each([
    ['', ''],
    ['  http://proxy.example:8080  ', 'http://proxy.example:8080'],
    ['https://127.0.0.1:443', 'https://127.0.0.1:443'],
    ['socks5://[::1]:1080', 'socks5://[::1]:1080']
  ])('normalizes %s', (value, expected) => {
    expect(proxyRulesForRuntime(value)).toBe(expected)
  })

  it.each([
    'ftp://proxy.example:21',
    'http://user:password@proxy.example:8080',
    'http://proxy.example:70000',
    'http://proxy.example/path',
    'http://invalid_host:8080'
  ])('ignores invalid persisted proxy %s', (value) => {
    expect(proxyRulesForRuntime(value)).toBe('')
  })
})
