import { DOCUMENT_IDS_MIME } from '../../utils/documentDrag'

export const WORKSPACE_DOCUMENT_MIME = DOCUMENT_IDS_MIME

export function hasWorkspaceDocumentPayload(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(WORKSPACE_DOCUMENT_MIME)
}

export function hasFilePayload(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes('Files')
}

export function hasWorkspaceDropPayload(dataTransfer: DataTransfer): boolean {
  return hasWorkspaceDocumentPayload(dataTransfer) || hasFilePayload(dataTransfer)
}

export function workspaceDocumentIds(dataTransfer: DataTransfer): string[] {
  const raw = dataTransfer.getData(WORKSPACE_DOCUMENT_MIME)
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return parsed.filter((value): value is string => typeof value === 'string' && value.length > 0)
    }
  } catch {
    return []
  }
  return []
}
