import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { committedFromParts } from '../src/modules/storage/s3-provider.js'

const M = 8 * 1024 * 1024
describe('committedFromParts', () => {
  it('sums contiguous parts', () => assert.equal(committedFromParts([{ PartNumber: 1, Size: M }, { PartNumber: 3, Size: M }], BigInt(3 * M)), BigInt(M)))
  it('backs off by the last part when all parts are present', () =>
    assert.equal(committedFromParts([{ PartNumber: 1, Size: M }, { PartNumber: 2, Size: 100 }], BigInt(M + 100)), BigInt(M)))
  it('single part upload backs off to 0', () => assert.equal(committedFromParts([{ PartNumber: 1, Size: 5 }], 5n), 0n))
})
