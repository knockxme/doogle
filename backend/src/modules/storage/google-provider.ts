import type { ConnectedAccount } from '@prisma/client'
import { Readable } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { ensureGoogleAppFolder, getAuthedGoogleClient } from '../google/google.service.js'
import { ProviderQuotaError, ProviderUnavailableError, type ReplicaUploadState, type StorageProvider } from './provider.js'

const QUOTA_REASONS = new Set(['userRateLimitExceeded', 'dailyLimitExceeded', 'uploadQuotaExceeded'])
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id'
const FILES_URL = 'https://www.googleapis.com/drive/v3/files'

export function classifyGoogleError(status: number, body: string): Error {
  const message = `Google Drive request failed (${status}).`
  if (status === 403 || status === 429) {
    let reasons: string[] = []
    try {
      const parsed = JSON.parse(body) as { error?: { errors?: { reason?: string }[] } }
      reasons = (parsed.error?.errors ?? []).map((e) => e.reason ?? '')
    } catch {
      // body is not JSON
    }
    if (status === 429 || reasons.some((r) => QUOTA_REASONS.has(r))) return new ProviderQuotaError(message)
    return new ProviderUnavailableError(message, false)
  }
  if (status === 401) return new ProviderUnavailableError(message, false)
  if (status === 404) return new ProviderUnavailableError(message, true)
  return new Error(message)
}

async function accessToken(account: ConnectedAccount) {
  try {
    const client = await getAuthedGoogleClient(account)
    const { token } = await client.getAccessToken()
    if (!token) throw new Error('empty token')
    return token
  } catch {
    throw new ProviderUnavailableError('Google authorization failed.', false)
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
    const token = await accessToken(account)
    const parent = await ensureGoogleAppFolder(account)
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
    await res.arrayBuffer().catch(() => undefined)
    // 499 means the session was cancelled; 404/410 mean it is already gone.
    if (![204, 404, 410, 499].includes(res.status) && !res.ok) throw await failure(res)
  },

  async readRange(account, providerFileId, start, end) {
    const token = await accessToken(account)
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
    const token = await accessToken(account)
    const res = await fetch(`${FILES_URL}/${encodeURIComponent(providerFileId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    await res.arrayBuffer().catch(() => undefined)
    if (res.status === 404 || res.ok) return
    throw await failure(res)
  },
}

export type { ReplicaUploadState }
