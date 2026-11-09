import type { ConnectedAccount } from '@prisma/client'
import { Readable } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { ensureGoogleAppFolder, getAuthedGoogleClient } from '../google/google.service.js'
import { ProviderQuotaError, ProviderUnavailableError, type ReplicaUploadState, type StorageProvider } from './provider.js'

const QUOTA_REASONS = new Set(['userRateLimitExceeded', 'dailyLimitExceeded', 'uploadQuotaExceeded', 'storageQuotaExceeded'])
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id'
const FILES_URL = 'https://www.googleapis.com/drive/v3/files'

export function classifyGoogleError(status: number, body: string): Error {
  const message = `Google Drive request failed (${status}).`
  if (status === 403) {
    let reasons: string[] = []
    try {
      const parsed = JSON.parse(body) as { error?: { errors?: { reason?: string }[] } }
      reasons = (parsed.error?.errors ?? []).map((e) => e.reason ?? '')
    } catch {
      // body is not JSON
    }
    if (reasons.some((r) => QUOTA_REASONS.has(r))) return new ProviderQuotaError(message)
    if (reasons.includes('rateLimitExceeded')) return new Error(message)
    // A non-quota 403 can be specific to one file, so it is not an account-level failure.
    return new Error(message)
  }
  if (status === 401) return new ProviderUnavailableError(message, false)
  if (status === 404) return new ProviderUnavailableError(message, true)
  return new Error(message)
}

/** Maps errors thrown by the googleapis client (GaxiosError-shaped) to provider errors. */
export function classifyGoogleClientError(error: unknown): Error {
  if (error instanceof ProviderQuotaError || error instanceof ProviderUnavailableError) return error
  const e = error as { code?: unknown; message?: string; response?: { status?: number; data?: unknown } } | null
  const dataText = typeof e?.response?.data === 'string' ? e.response.data : JSON.stringify(e?.response?.data ?? '')
  if (/invalid_grant|invalid_client/i.test(String(e?.message ?? '') + String(e?.code ?? '') + dataText)) {
    return new ProviderUnavailableError('Google authorization failed.', false)
  }
  const status = e?.response?.status ?? (typeof e?.code === 'number' ? e.code : Number(e?.code))
  if (Number.isInteger(status) && (status as number) >= 100) {
    const data = e?.response?.data
    return classifyGoogleError(status as number, typeof data === 'string' ? data : JSON.stringify(data ?? ''))
  }
  if (/invalid_grant|invalid_client|unauthorized/i.test(String(e?.message ?? '') + String(e?.code ?? ''))) {
    return new ProviderUnavailableError('Google authorization failed.', false)
  }
  return error instanceof Error ? error : new Error('Google request failed.')
}

/** Only a real refusal marks the account; a network failure during token refresh stays a plain error. */
export function classifyTokenError(error: unknown): Error {
  const classified = classifyGoogleClientError(error)
  if (classified instanceof ProviderUnavailableError || classified instanceof ProviderQuotaError) return classified
  return new Error('Google token request failed.')
}

export const googleDeps = { getToken: accessToken, ensureFolder: ensureGoogleAppFolder }

async function accessToken(account: ConnectedAccount) {
  try {
    const client = await getAuthedGoogleClient(account)
    const { token } = await client.getAccessToken()
    if (!token) throw new Error('empty token')
    return token
  } catch (error) {
    throw classifyTokenError(error)
  }
}

async function failure(res: Response) {
  return classifyGoogleError(res.status, await res.text().catch(() => ''))
}

function parseRangeEnd(header: string | null): bigint | null {
  const m = /bytes=\d+-(\d+)/.exec(header ?? '')
  return m ? BigInt(m[1]!) : null
}

async function* sliceStream(source: Readable, start: number, length: number) {
  let skipped = 0
  let sent = 0
  for await (const piece of source) {
    let buf = Buffer.from(piece)
    if (skipped < start) {
      const drop = Math.min(start - skipped, buf.length)
      skipped += drop
      buf = buf.subarray(drop)
    }
    if (buf.length === 0) continue
    const take = buf.subarray(0, length - sent)
    sent += take.length
    yield take
    if (sent >= length) {
      source.destroy()
      return
    }
  }
}

export const googleProvider: StorageProvider = {
  async beginUpload(account, blobName, encryptedSize) {
    const token = await googleDeps.getToken(account)
    let parent: string
    try {
      parent = await googleDeps.ensureFolder(account)
    } catch (error) {
      throw classifyGoogleClientError(error)
    }
    const res = await fetch(UPLOAD_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': 'application/octet-stream',
        'X-Upload-Content-Length': encryptedSize.toString(),
      },
      body: JSON.stringify({ name: blobName, mimeType: 'application/octet-stream', parents: [parent] }),
    })
    if (!res.ok) throw await failure(res)
    const sessionUri = res.headers.get('location')
    if (!sessionUri) throw new Error('Google did not return an upload session.')
    return { sessionUri }
  },

  async putChunk(account, state, offset, chunk, totalSize) {
    if (!state.sessionUri) throw new Error('Upload state has no session.')
    const end = offset + BigInt(chunk.length) - 1n
    const res = await fetch(state.sessionUri, {
      method: 'PUT',
      headers: { 'Content-Range': `bytes ${offset}-${end}/${totalSize}`, 'Content-Length': String(chunk.length) },
      body: new Uint8Array(chunk),
    })
    if (res.status === 200 || res.status === 201) {
      const json = (await res.json()) as { id?: string }
      if (!json.id) throw new Error('Google did not return a file id.')
      return { state: { ...state, providerFileId: json.id }, complete: true }
    }
    if (res.status === 308) {
      await res.arrayBuffer().catch(() => undefined)
      const committedEnd = parseRangeEnd(res.headers.get('range'))
      if (committedEnd === null || committedEnd < end) {
        throw new Error('Google committed only part of the chunk; resume via committedOffset.')
      }
      return { state: { ...state }, complete: false }
    }
    throw await failure(res)
  },

  async committedOffset(account, state, totalSize) {
    if (!state.sessionUri) throw new Error('Upload state has no session.')
    const res = await fetch(state.sessionUri, {
      method: 'PUT',
      headers: { 'Content-Range': `bytes */${totalSize}`, 'Content-Length': '0' },
    })
    if (res.status === 200 || res.status === 201) {
      const json = (await res.json().catch(() => ({}))) as { id?: string }
      if (json.id) state.providerFileId = json.id
      return totalSize
    }
    if (res.status === 308) {
      await res.arrayBuffer().catch(() => undefined)
      const e = parseRangeEnd(res.headers.get('range'))
      return e === null ? 0n : e + 1n
    }
    throw await failure(res)
  },

  async abortUpload(_account, state) {
    if (!state.sessionUri) return
    const res = await fetch(state.sessionUri, { method: 'DELETE', headers: { 'Content-Length': '0' } })
    // 499 means the session was cancelled; 404/410 mean it is already gone.
    if ([204, 404, 410, 499].includes(res.status) || res.ok) {
      await res.arrayBuffer().catch(() => undefined)
      return
    }
    throw await failure(res)
  },

  async readRange(account, providerFileId, start, end) {
    const token = await googleDeps.getToken(account)
    const res = await fetch(`${FILES_URL}/${encodeURIComponent(providerFileId)}?alt=media`, {
      headers: { Authorization: `Bearer ${token}`, Range: `bytes=${start}-${end}` },
    })
    if (res.status !== 200 && res.status !== 206) throw await failure(res)
    if (!res.body) throw new Error('Google returned an empty body.')
    const stream = Readable.fromWeb(res.body as unknown as WebReadableStream)
    if (res.status === 206) return stream
    // Range ignored: slice the full body ourselves.
    return Readable.from(sliceStream(stream, Number(start), Number(end - start + 1n)))
  },

  async deleteBlob(account, providerFileId) {
    const token = await googleDeps.getToken(account)
    const res = await fetch(`${FILES_URL}/${encodeURIComponent(providerFileId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.status === 404 || res.ok) {
      await res.arrayBuffer().catch(() => undefined)
      return
    }
    throw await failure(res)
  },
}

export type { ReplicaUploadState }
