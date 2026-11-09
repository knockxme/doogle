import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { classifyGoogleError } from '../src/modules/storage/google-provider.js'
import { ProviderQuotaError, ProviderUnavailableError } from '../src/modules/storage/provider.js'

const body = (reason: string) => JSON.stringify({ error: { errors: [{ reason }], message: 'x' } })

describe('classifyGoogleError', () => {
  for (const reason of ['userRateLimitExceeded', 'dailyLimitExceeded', 'uploadQuotaExceeded'])
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
