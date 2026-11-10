export type PreviewKind = 'image' | 'video' | 'audio' | 'document'

export function getPreviewKind(mimeType: string | undefined): PreviewKind | null {
  if (!mimeType) return null
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType.startsWith('audio/')) return 'audio'
  if (mimeType === 'application/pdf') return 'document'
  return null
}

const officeMimeTypes = new Set([
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
])

export function isOfficeMimeType(mimeType: string | undefined) {
  return Boolean(mimeType && officeMimeTypes.has(mimeType))
}

export function isSpreadsheetMimeType(mimeType: string | undefined) {
  return mimeType === 'application/vnd.ms-excel' || mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
}
