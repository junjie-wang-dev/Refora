import { describe, it, expect } from 'vitest'
import en from '../../src/renderer/i18n/locales/en.json'
import zh from '../../src/renderer/i18n/locales/zh.json'

const NAMESPACES = [
  'sidebar',
  'topbar',
  'list',
  'detail',
  'settings',
  'common',
  'dialog'
] as const

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/

function collectLeaves(
  value: unknown,
  prefix = '',
  result = new Map<string, string[]>()
): Map<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      collectLeaves(child, path, result)
      continue
    }
    const logicalPath = path.replace(PLURAL_SUFFIX, '')
    const placeholders = typeof child === 'string'
      ? [...child.matchAll(/{{\s*([^},\s]+)/g)].map((match) => match[1]).sort().join(',')
      : ''
    const signatures = result.get(logicalPath) ?? []
    signatures.push(placeholders)
    result.set(logicalPath, signatures)
  }
  return result
}

describe('i18n locale files (master plan §8 namespaces)', () => {
  it('en.json has all namespaces', () => {
    for (const ns of NAMESPACES) {
      expect(en).toHaveProperty(ns)
    }
  })

  it('zh.json has all namespaces', () => {
    for (const ns of NAMESPACES) {
      expect(zh).toHaveProperty(ns)
    }
  })

  it('en and zh share the same keys in every namespace', () => {
    const enLeaves = collectLeaves(en)
    const zhLeaves = collectLeaves(zh)

    expect([...enLeaves.keys()].sort()).toEqual([...zhLeaves.keys()].sort())
    for (const key of enLeaves.keys()) {
      expect([...new Set(enLeaves.get(key))].sort()).toEqual(
        [...new Set(zhLeaves.get(key))].sort()
      )
    }
  })

  it('interpolation placeholders are preserved across languages', () => {
    expect(en.common.multiSelected).toContain('{{count}}')
    expect(zh.common.multiSelected).toContain('{{count}}')
    expect(en.dialog.duplicateWarning).toContain('{{name}}')
    expect(zh.dialog.duplicateWarning).toContain('{{name}}')
  })

  it('provides translations for editing and the empty chat controls', () => {
    for (const locale of [en, zh]) {
      for (const key of [
        'common.edit',
        'workspace.chat.noThreads',
        'common.contextMenuFailed',
        'workspace.chat.newConversation',
        'workspace.chat.threadHistory',
        'workspace.chat.suggestionSummarize',
        'workspace.chat.suggestionCompare',
        'workspace.chat.suggestionReport'
      ]) {
        expect(locale).toHaveProperty(key, expect.any(String))
      }
    }
    expect(zh.common.edit).toBe('编辑')
    expect(zh.workspace.chat.noThreads).toBe('暂无对话')
    expect(zh.workspace.chat.threadHistory).toBe('对话历史')
  })
})
