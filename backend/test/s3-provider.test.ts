import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { committedFromParts, mapS3Error } from '../src/modules/storage/s3-provider.js'
import { ProviderUnavailableError } from '../src/modules/storage/provider.js'

const M = 8 * 1024 * 1024
describe('committedFromParts', () => {
  it('sums contiguous parts', () => assert.equal(committedFromParts([{ PartNumber: 1, Size: M }, { PartNumber: 3, Size: M }], BigInt(3 * M)), BigInt(M)))
  it('backs off by the last part when all parts are present', () =>
    assert.equal(committedFromParts([{ PartNumber: 1, Size: M }, { PartNumber: 2, Size: 100 }], BigInt(M + 100)), BigInt(M)))
  it('single part upload backs off to 0', () => assert.equal(committedFromParts([{ PartNumber: 1, Size: 5 }], 5n), 0n))
})

const s3Error = (name: string, httpStatusCode: number) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode } })
function mapped(error: unknown, op: 'object' | 'other'): ProviderUnavailableError {
  try {
    mapS3Error(error, op)
  } catch (e) {
    assert.ok(e instanceof ProviderUnavailableError, `expected ProviderUnavailableError, got ${String(e)}`)
    return e
  }
  assert.fail('mapS3Error did not throw')
}

describe('mapS3Error', () => {
  it('a missing object is notFound', () => {
    assert.equal(mapped(s3Error('NoSuchKey', 404), 'object').notFound, true)
    assert.equal(mapped(s3Error('NotFound', 404), 'object').notFound, true)
  })
  it('a missing bucket is unavailable, not notFound, on any call', () => {
    assert.equal(mapped(s3Error('NoSuchBucket', 404), 'object').notFound, false)
    assert.equal(mapped(s3Error('NoSuchBucket', 404), 'other').notFound, false)
  })
  it('a 404 that is not about the object is not notFound', () => {
    assert.equal(mapped(s3Error('SomethingElse', 404), 'other').notFound, false)
    assert.equal(mapped(s3Error('NotFound', 404), 'other').notFound, false)
  })
  it('a missing multipart upload stays notFound', () => assert.equal(mapped(s3Error('NoSuchUpload', 404), 'other').notFound, true))
  it('access denied is unavailable', () => assert.equal(mapped(s3Error('AccessDenied', 403), 'other').notFound, false))
  it('other errors are rethrown unchanged', () => {
    const e = s3Error('InternalError', 500)
    assert.throws(() => mapS3Error(e, 'object'), (x) => x === e)
  })
})
