function validIpv4(value: string): boolean {
  const parts = value.split('.')
  return parts.length === 4 && parts.every((part) => {
    const number = Number(part)
    return part.length > 0 &&
      String(number) === part &&
      Number.isInteger(number) &&
      number >= 0 &&
      number <= 255
  })
}

function validIpv6(value: string): boolean {
  if (!/^[0-9a-f:.]+$/i.test(value) || (value.match(/::/g) ?? []).length > 1) return false
  const parts = value.split(':')
  let units = 0
  for (const [index, part] of parts.entries()) {
    if (!part) continue
    if (part.includes('.')) {
      if (index !== parts.length - 1 || !validIpv4(part)) return false
      units += 2
    } else {
      if (!/^[0-9a-f]{1,4}$/i.test(part)) return false
      units += 1
    }
  }
  return value.includes('::') ? units < 8 : units === 8
}

function validProxyHostname(value: string): boolean {
  const hostname = value.startsWith('[') && value.endsWith(']')
    ? value.slice(1, -1)
    : value
  if (!hostname || hostname.length > 253) return false
  if (hostname.includes(':')) return validIpv6(hostname)
  if (/^[0-9.]+$/.test(hostname)) {
    return validIpv4(hostname)
  }
  return hostname.replace(/\.$/, '').split('.').every((label) =>
    /^[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?$/u.test(label)
  )
}

export function proxyRulesForRuntime(value: unknown): string {
  if (typeof value !== 'string') return ''
  const rules = value.trim()
  if (!rules) return ''
  if (/\s/.test(rules)) return ''
  const match = /^(?:https?|socks5):\/\/(\[[0-9a-f:.]+\]|[^:/?#]+)(?::([0-9]{1,5}))?$/i.exec(rules)
  if (!match || !validProxyHostname(match[1])) return ''
  if (match[2]) {
    const port = Number(match[2])
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return ''
  }
  return rules
}
