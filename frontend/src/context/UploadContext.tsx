import { createContext, useContext, useState, type ReactNode } from 'react'
import { API_URL, ApiError, apiFetch, errorCode, errorMessage, isTokenFailure, refreshAccessToken } from '@/lib/api'
import { clearAuthSession, getAccessToken } from '@/lib/auth'

export type UploadProgressStatus = 'uploading' | 'done' | 'error' | 'partial'
export type UploadProgressFile = { name: string; size: number; percent: number; status: UploadProgressStatus; message?: string }
export type UploadProgressState = { open: boolean; fileName: string; percent: number; status: UploadProgressStatus; files: UploadProgressFile[] }

type ResumableSession = { sessionId: string; file: File; folderId?: string | null }

type UploadContextType = {
  uploadProgress: UploadProgressState
  setUploadProgress: React.Dispatch<React.SetStateAction<UploadProgressState>>
  uploadFiles: (files: File[], folderId: string | null) => Promise<void>
  retryFailedUpload: (fileName: string) => Promise<void>
}

const UploadContext = createContext<UploadContextType | undefined>(undefined)

// 8 encrypted frames of plaintext. The server sends its own value on init; this is the fallback.
const CHUNK_SIZE = 8388384
const MAX_CHUNK_RETRIES = 5

const uploadMessages: Record<string, string> = {
  NO_ACCOUNT_WITH_ENOUGH_SPACE: 'The family storage pool does not have enough free space (two storage accounts with room are needed). Ask the admin to add storage.',
  USER_STORAGE_LIMIT_REACHED: 'You have reached your storage limit. Delete some files or ask the admin to raise it.',
  STORAGE_ACCOUNT_QUOTA_EXCEEDED: 'A storage account ran out of space during the upload. Try again later or ask the admin to add storage.',
  STORAGE_ACCOUNT_UNAVAILABLE: 'A storage account is unavailable right now. Try again later or tell the admin.',
  UPLOAD_SIZE_REQUIRED: 'This file is empty or its size is unknown. Empty files cannot be uploaded.',
  UPLOAD_TOO_LARGE: 'This file is larger than the maximum upload size.',
  CHUNK_NOT_ALIGNED: 'The upload went out of step with the server. Use Retry to continue.',
  UPLOAD_NOT_ACTIVE: 'This upload is no longer active. Use Retry to start it again.',
  FOLDER_NOT_FOUND: 'The target folder no longer exists.',
}

class UploadFailure extends Error {
  code?: string
  constructor(message: string, code?: string) {
    super(message)
    this.code = code
  }
}

function failureFrom(error: unknown): UploadFailure {
  if (error instanceof UploadFailure) return error
  const code = errorCode(error)
  const fallback = errorMessage(error, 'Upload failed')
  return new UploadFailure((code && uploadMessages[code]) || fallback, code)
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export function UploadProvider({ children }: { children: ReactNode }) {
  const [uploadProgress, setUploadProgress] = useState<UploadProgressState>({
    open: false,
    fileName: '',
    percent: 0,
    status: 'uploading',
    files: []
  })
  const [resumableSessions, setResumableSessions] = useState<Record<string, ResumableSession>>({})

  async function sendChunk(sessionId: string, file: File, startOffset: number, chunkSize: number) {
    const endOffset = Math.min(startOffset + chunkSize, file.size)
    const chunk = file.slice(startOffset, endOffset)
    const put = () => fetch(`${API_URL}/uploads/resumable/chunk/${sessionId}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${getAccessToken()}`,
        'Content-Range': `bytes ${startOffset}-${endOffset - 1}/${file.size}`,
      },
      body: chunk
    })
    // Raw fetch with the bearer token for the binary body. A long upload outlives the access token: refresh once and resend the same chunk.
    let response = await put()
    let body: { code?: string; message?: string } = {}
    if (!response.ok) {
      body = await response.json().catch(() => ({})) as typeof body
      if (response.status === 401 && isTokenFailure(body.code)) {
        if (await refreshAccessToken()) {
          response = await put()
          body = response.ok ? {} : await response.json().catch(() => ({})) as typeof body
        } else {
          clearAuthSession()
        }
      }
    }
    if (response.ok) return await response.json() as { status: string; offset?: string }
    throw new ApiError(response.status, body.message ?? 'Chunk upload failed', body.code, body)
  }

  async function uploadSingleFileResumable(file: File, folderId: string | null, onProgress: (percent: number) => void, sessionIdToRetry?: string) {
    if (file.size === 0) throw new UploadFailure(uploadMessages.UPLOAD_SIZE_REQUIRED, 'UPLOAD_SIZE_REQUIRED')

    let sessionId = sessionIdToRetry || ''
    let startOffset = 0
    let chunkSize = CHUNK_SIZE

    // Pre-save session parameters so that retry is functional even if the init API call fails
    setResumableSessions(prev => ({ ...prev, [file.name]: { sessionId, file, folderId } }))

    try {
      // A retry resumes only a session the server still considers active.
      if (sessionId) {
        const statusData = await apiFetch<{ status: string; offset: string }>(`/uploads/resumable/status/${sessionId}`).catch(() => null)
        if (statusData?.status === 'completed') {
          onProgress(100)
          return
        }
        if (statusData?.status === 'uploading') startOffset = Number(statusData.offset)
        else sessionId = ''
      }

      if (!sessionId) {
        const initData = await apiFetch<{ sessionId: string; chunkSize?: string | number }>('/uploads/resumable/init', {
          method: 'POST',
          body: JSON.stringify({
            fileName: file.name,
            mimeType: file.type || 'application/octet-stream',
            sizeBytes: String(file.size),
            folderId: folderId || undefined,
          })
        })
        sessionId = initData.sessionId
        const serverChunk = Number(initData.chunkSize)
        if (Number.isFinite(serverChunk) && serverChunk > 0) chunkSize = serverChunk
        setResumableSessions(prev => ({ ...prev, [file.name]: { sessionId, file, folderId } }))
      }

      let retries = 0
      // Asks the server where it got to. A failed lookup uses the same retry budget as a failed chunk.
      const resync = async (): Promise<'completed' | 'resumed'> => {
        for (;;) {
          retries += 1
          await wait(Math.min(500 * 2 ** retries, 8000))
          try {
            const statusData = await apiFetch<{ status: string; offset: string }>(`/uploads/resumable/status/${sessionId}`)
            if (statusData.status === 'completed') return 'completed'
            if (statusData.status !== 'uploading') throw new UploadFailure(uploadMessages.UPLOAD_NOT_ACTIVE, 'UPLOAD_NOT_ACTIVE')
            startOffset = Number(statusData.offset)
            return 'resumed'
          } catch (err) {
            if (err instanceof UploadFailure) throw err
            const transient = !(err instanceof ApiError) || err.status >= 500 || err.code === 'UPLOAD_CHUNK_RETRY'
            if (!transient) throw err
            if (retries >= MAX_CHUNK_RETRIES) throw new UploadFailure('The upload kept failing after several attempts. Check your connection and use Retry.', errorCode(err))
          }
        }
      }
      while (startOffset < file.size) {
        try {
          const resData = await sendChunk(sessionId, file, startOffset, chunkSize)
          retries = 0
          if (resData.status === 'completed') {
            onProgress(100)
            return
          }
          startOffset = Number(resData.offset)
          onProgress(Math.min(99, Math.round((startOffset / file.size) * 100)))
        } catch (err) {
          const code = errorCode(err)
          // A dropped connection or a server asking for a retry: ask where the server got to and carry on from there.
          const transient = code === 'UPLOAD_CHUNK_RETRY' || !(err instanceof ApiError)
          if (!transient) throw err
          if (retries >= MAX_CHUNK_RETRIES) throw new UploadFailure('The upload kept failing after several attempts. Check your connection and use Retry.', code)
          if (await resync() === 'completed') {
            onProgress(100)
            return
          }
        }
      }
    } catch (err) {
      throw failureFrom(err)
    }
  }

  async function uploadFiles(filesToUpload: File[], targetFolderId: string | null) {
    if (filesToUpload.length === 0) return

    // Setup initial status
    setUploadProgress({
      open: true,
      fileName: filesToUpload.length === 1 ? filesToUpload[0].name : `${filesToUpload.length} files`,
      percent: 0,
      status: 'uploading',
      files: filesToUpload.map(f => ({ name: f.name, size: f.size, percent: 0, status: 'uploading' }))
    })

    // Upload files sequentially
    for (let i = 0; i < filesToUpload.length; i++) {
      const file = filesToUpload[i]
      try {
        await uploadSingleFileResumable(file, targetFolderId, (filePercent) => {
          setUploadProgress((current) => {
            const nextFiles = [...current.files]
            if (nextFiles[i]) {
              nextFiles[i] = { ...nextFiles[i], percent: filePercent, status: filePercent >= 100 ? 'done' : 'uploading' }
            }
            const overallPercent = Math.round(nextFiles.reduce((sum, f) => sum + f.percent, 0) / nextFiles.length)
            return {
              ...current,
              percent: overallPercent,
              files: nextFiles
            }
          })
        })
      } catch (err) {
        console.error('File upload failed:', file.name, err)
        const message = failureFrom(err).message
        setUploadProgress((current) => {
          const nextFiles = [...current.files]
          if (nextFiles[i]) {
            nextFiles[i] = { ...nextFiles[i], status: 'error', message }
          }
          return {
            ...current,
            status: 'partial',
            files: nextFiles
          }
        })
      }
    }

    setUploadProgress((current) => current.status === 'uploading' && current.files.every((f) => f.status === 'done') ? { ...current, status: 'done', percent: 100 } : current)

    // Dispatch global events so active pages reload their data
    window.dispatchEvent(new Event('9drive:storage-changed'))
    window.dispatchEvent(new Event('9drive:upload-completed'))
  }

  async function retryFailedUpload(fileName: string) {
    const session = resumableSessions[fileName]
    if (!session) return

    setUploadProgress((current) => {
      const nextFiles = current.files.map(f => f.name === fileName ? { ...f, status: 'uploading' as const, message: undefined } : f)
      return {
        ...current,
        status: 'uploading',
        files: nextFiles
      }
    })

    try {
      const fileIndex = uploadProgress.files.findIndex(f => f.name === fileName)
      await uploadSingleFileResumable(session.file, session.folderId || null, (filePercent) => {
        setUploadProgress((current) => {
          const nextFiles = [...current.files]
          if (nextFiles[fileIndex]) {
            nextFiles[fileIndex] = { ...nextFiles[fileIndex], percent: filePercent, status: filePercent >= 100 ? 'done' : 'uploading' }
          }
          const overallPercent = Math.round(nextFiles.reduce((sum, f) => sum + f.percent, 0) / nextFiles.length)
          const allDone = nextFiles.every(f => f.status === 'done')
          return {
            ...current,
            percent: overallPercent,
            status: allDone ? 'done' : 'uploading',
            files: nextFiles
          }
        })
      }, session.sessionId)

      window.dispatchEvent(new Event('9drive:storage-changed'))
      window.dispatchEvent(new Event('9drive:upload-completed'))
    } catch (err) {
      console.error('Retry upload failed:', fileName, err)
      const message = failureFrom(err).message
      setUploadProgress((current) => {
        const nextFiles = current.files.map(f => f.name === fileName ? { ...f, status: 'error' as const, message } : f)
        return {
          ...current,
          status: 'partial',
          files: nextFiles
        }
      })
    }
  }

  return (
    <UploadContext.Provider value={{ uploadProgress, setUploadProgress, uploadFiles, retryFailedUpload }}>
      {children}
    </UploadContext.Provider>
  )
}

export function useUpload() {
  const context = useContext(UploadContext)
  if (context === undefined) {
    throw new Error('useUpload must be used within an UploadProvider')
  }
  return context
}
