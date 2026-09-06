import type { ChatMediaContext, ChatMediaSource } from '../../shared/ipc-types'

const DATA_MEDIA = /^data:(image\/(?:png|jpeg|jpg|gif|webp|avif)|audio\/(?:mpeg|mp3|wav|x-wav|wave|vnd\.wave|ogg|webm|mp4|mp4a-latm|x-m4a|x-mpeg)|video\/(?:mp4|x-m4v|webm|ogg));base64,[a-zA-Z0-9+/=\s]+$/i
const MAX_INLINE_URL_LENGTH = 28_000_000

function cleanSegments(value: string): string[] | null {
  try {
    const parts = value.split('/').filter(Boolean).map(decodeURIComponent)
    return parts.length && parts.every((part) => part !== '.' && part !== '..' && !/[\\/]/.test(part) && ![...part].some((character) => character.charCodeAt(0) < 32)) ? parts : null
  } catch {
    return null
  }
}

export function mediaSourceFromUrl(value: string, context: ChatMediaContext = {}): ChatMediaSource | null {
  const url = value.trim()
  if (!url) return null
  if (url.startsWith('data:')) {
    return url.length <= MAX_INLINE_URL_LENGTH && DATA_MEDIA.test(url) ? { type: 'inline', dataUrl: url } : null
  }
  if (/^https?:\/\//i.test(url)) {
    try {
      const parsed = new URL(url)
      if (parsed.username || parsed.password || !parsed.hostname || url.length > 2048) return null
      return { type: 'remote', url: parsed.href }
    } catch {
      return null
    }
  }
  if (/^refora-(?:asset|document):\/\//.test(url)) {
    try {
      const parsed = new URL(url)
      const parts = cleanSegments(parsed.pathname)
      if (!parts || parsed.username || parsed.password || parsed.port) return null
      if (parsed.protocol === 'refora-asset:' && parts.length === 1) {
        if (parsed.hostname === 'asset') return { type: 'asset', assetId: parts[0] }
        if (parsed.hostname === 'media' && /^[a-f0-9]{64}$/.test(parts[0])) return { type: 'cached', mediaId: parts[0] }
      }
      if (parsed.protocol === 'refora-document:' && parsed.hostname === 'ocr' && parts.length >= 4 && ['assets', 'images'].includes(parts[2])) {
        return { type: 'ocr', documentId: parts[0], resultKey: parts[1], path: ['assets', ...parts.slice(3)].join('/') }
      }
    } catch {
      return null
    }
    return null
  }
  const relative = url.replace(/^\.\//, '').replace(/^\//, '')
  const parts = cleanSegments(relative)
  if (!parts || url.includes(':') || url.startsWith('//') || /[?#]/.test(url)) return null
  if (['images', 'assets'].includes(parts[0]) && parts.length > 1 && context.documentId && context.resultKey) {
    return { type: 'ocr', documentId: context.documentId, resultKey: context.resultKey, path: ['assets', ...parts.slice(1)].join('/') }
  }
  if (parts[0] === 'outputs' && parts.length > 1 && context.runId) {
    return { type: 'sandbox', runId: context.runId, path: parts.join('/') }
  }
  return null
}

export function isSafeMediaUrl(url: string): boolean {
  if (mediaSourceFromUrl(url)) return true
  const relative = url.replace(/^\.\//, '').replace(/^\//, '')
  const parts = cleanSegments(relative)
  return Boolean(parts && parts.length > 1 && ['images', 'assets', 'outputs'].includes(parts[0]) && !/[:?#]/.test(url) && !url.startsWith('//'))
}
