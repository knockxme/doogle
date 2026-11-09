import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ConnectedAccount } from '@prisma/client'
import { classifyGoogleClientError, classifyGoogleError, googleDeps, googleProvider } from '../src/modules/storage/google-provider.js'
import { ProviderQuotaError, ProviderUnavailableError } from '../src/modules/storage/provider.js'

const body = (reason: string) => JSON.stringify({ error: { errors: [{ reason }], message: 'x' } })

describe('classifyGoogleError', () => {
  it('403 rateLimitExceeded and 429 are plain retryable errors', () => {
    for (const e of [classifyGoogleError(403, body('rateLimitExceeded')), classifyGoogleError(429, '')]) assert.equal(e.constructor, Error)
  })
  for (const reason of ['userRateLimitExceeded', 'dailyLimitExceeded', 'uploadQuotaExceeded', 'storageQuotaExceeded'])
    it(`403 ${reason} -> quota`, () => assert.ok(classifyGoogleError(403, body(reason)) instanceof ProviderQuotaError))
  it('403 other reason is not quota', () => assert.ok(!(classifyGoogleError(403, body('forbidden')) instanceof ProviderQuotaError)))
  it('401 -> unavailable, notFound false', () => {
    const e = classifyGoogleError(401, '')
    assert.ok(e instanceof ProviderUnavailableError)
    assert.equal(e.notFound, false)
  })
  it('404 -> notFound', () => {
    const e = classifyGoogleError(404, '')
    assert.ok(e instanceof ProviderUnavailableError)
    assert.equal(e.notFound, true)
  })
  it('503 -> plain Error', () => {
    const e = classifyGoogleError(503, 'busy')
    assert.ok(!(e instanceof ProviderUnavailableError) && !(e instanceof ProviderQuotaError))
    assert.equal(e.constructor, Error)
  })
})

const acct = { id: 'a' } as unknown as ConnectedAccount
describe('google provider with stubbed fetch', () => {
  it('deleteBlob keeps the 403 quota reason', async () => {
    const realFetch = globalThis.fetch
    const realToken = googleDeps.getToken
    globalThis.fetch = (async () => new Response(body('storageQuotaExceeded'), { status: 403 })) as typeof fetch
    googleDeps.getToken = async () => 't'
    try {
      await assert.rejects(googleProvider.deleteBlob(acct, 'f'), (e: unknown) => e instanceof ProviderQuotaError)
    } finally {
      globalThis.fetch = realFetch
      googleDeps.getToken = realToken
    }
  })
  it('abortUpload keeps the 403 quota reason', async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(body('dailyLimitExceeded'), { status: 403 })) as typeof fetch
    try {
      await assert.rejects(googleProvider.abortUpload(acct, { sessionUri: 'https://x' }), (e: unknown) => e instanceof ProviderQuotaError)
    } finally {
      globalThis.fetch = realFetch
    }
  })
  it('beginUpload classifies ensureGoogleAppFolder errors', async () => {
    const realFolder = googleDeps.ensureFolder
    const realToken = googleDeps.getToken
    googleDeps.getToken = async () => 't'
    googleDeps.ensureFolder = async () => { throw Object.assign(new Error('x'), { response: { status: 403, data: { error: { errors: [{ reason: 'storageQuotaExceeded' }] } } } }) }
    try {
      await assert.rejects(googleProvider.beginUpload(acct, 'n', 1n), (e: unknown) => e instanceof ProviderQuotaError)
    } finally {
      googleDeps.ensureFolder = realFolder
      googleDeps.getToken = realToken
    }
  })
  it('classifyGoogleClientError maps 401 and invalid_grant', () => {
    const a = classifyGoogleClientError({ response: { status: 401, data: '' } })
    assert.ok(a instanceof ProviderUnavailableError && !a.notFound)
    assert.ok(classifyGoogleClientError(new Error('invalid_grant')) instanceof ProviderUnavailableError)
  })
})
