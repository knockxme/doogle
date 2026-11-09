import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { FRAME_PLAINTEXT } from '../src/modules/crypto/frames.js'
import { parseRange, frameSpan } from '../src/modules/crypto/range.js'

const P = BigInt(FRAME_PLAINTEXT)
const s = 3n * P + 10n

describe('parseRange', () => {
  it('returns null with no header', () => assert.equal(parseRange(undefined, s), null))
  it('parses bytes=0-0', () => assert.deepEqual(parseRange('bytes=0-0', s), { start: 0n, end: 0n }))
  it('parses suffix', () => assert.deepEqual(parseRange('bytes=-500', s), { start: s - 500n, end: s - 1n }))
  it('clamps oversized suffix to whole file', () =>
    assert.deepEqual(parseRange('bytes=-99999999', s), { start: 0n, end: s - 1n }))
  it('parses open end', () => assert.deepEqual(parseRange('bytes=5-', s), { start: 5n, end: s - 1n }))
  it('start at size is unsatisfiable', () => assert.equal(parseRange(`bytes=${s}-`, s), 'unsatisfiable'))
  it('clamps end beyond size', () =>
    assert.deepEqual(parseRange('bytes=10-999999999999', s), { start: 10n, end: s - 1n }))
  it('malformed and multi-range give null', () => {
    for (const h of ['garbage', 'bytes=', 'bytes=a-b', 'bytes=0-1,5-6', 'bytes=-', 'bytes=5-2'])
      assert.equal(parseRange(h, s), null)
  })
})

describe('frameSpan', () => {
  it('spans a frame boundary', () => {
    assert.deepEqual(frameSpan({ start: P - 1n, end: P }), {
      firstFrame: 0,
      lastFrame: 1,
      cipherStart: 0n,
      cipherEnd: 2097151n,
      skipHead: FRAME_PLAINTEXT - 1,
    })
  })
  it('maps a mid-file range', () => {
    const r = frameSpan({ start: 2n * P + 3n, end: 2n * P + 3n })
    assert.equal(r.firstFrame, 2)
    assert.equal(r.lastFrame, 2)
    assert.equal(r.cipherStart, 2097152n)
    assert.equal(r.skipHead, 3)
  })
})
