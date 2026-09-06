const OPENABLE_MEDIA_MIMES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif',
  'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg', 'audio/webm', 'audio/mp4',
  'video/mp4', 'video/webm', 'video/ogg', 'application/pdf',
  'text/plain', 'text/csv', 'text/tab-separated-values', 'text/markdown', 'application/json',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'
])

export function canOpenChatMedia(mimeType: string): boolean {
  return OPENABLE_MEDIA_MIMES.has(mimeType)
}
