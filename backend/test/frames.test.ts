import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'
import {
  FRAME_OVERHEAD,
  FRAME_PLAINTEXT,
  FRAME_SIZE,
  FrameAuthError,
  UPLOAD_CHUNK_PLAINTEXT,
  decryptFrame,
  encryptFrame,
  encryptedSize,
  frameCount,
} from '../src/modules/crypto/frames.js'

const key = crypto.randomBytes(32)
const fileId = 'file-1'

test('constants', () => {
  assert.equal(FRAME_SIZE, 1048576)
  assert.equal(FRAME_OVERHEAD, 28)
  assert.equal(FRAME_PLAINTEXT, 1048548)
  assert.equal(UPLOAD_CHUNK_PLAINTEXT, 8 * 1048548)
})

test('frameCount and encryptedSize', () => {
  assert.equal(frameCount(1n), 1n)
  assert.equal(frameCount(BigInt(FRAME_PLAINTEXT)), 1n)
  assert.equal(frameCount(BigInt(FRAME_PLAINTEXT) + 1n), 2n)
  assert.equal(encryptedSize(BigInt(FRAME_PLAINTEXT)), 1048576n)
  assert.equal(encryptedSize(BigInt(FRAME_PLAINTEXT) + 1n), 1048576n + 29n)
})

test('round trip full and short final frames', () => {
  const full = crypto.randomBytes(FRAME_PLAINTEXT)
  const f = encryptFrame(key, fileId, 0, false, full)
  assert.equal(f.length, FRAME_SIZE)
  assert.ok(decryptFrame(key, fileId, 0, false, f).equals(full))
  const short = crypto.randomBytes(100)
  const g = encryptFrame(key, fileId, 3, true, short)
  assert.equal(g.length, 128)
  assert.ok(decryptFrame(key, fileId, 3, true, g).equals(short))
})

test('deterministic, and nonce depends on plaintext', () => {
  const a = Buffer.from('aaaa')
  const b = Buffer.from('bbbb')
  assert.ok(encryptFrame(key, fileId, 1, false, a).equals(encryptFrame(key, fileId, 1, false, a)))
  const fa = encryptFrame(key, fileId, 1, false, a)
  const fb = encryptFrame(key, fileId, 1, false, b)
  assert.ok(!fa.subarray(0, 12).equals(fb.subarray(0, 12)))
})

test('tampering raises FrameAuthError', () => {
  const f = encryptFrame(key, fileId, 2, false, Buffer.from('hello'))
  const flipped = Buffer.from(f)
  flipped[14] ^= 1
  assert.throws(() => decryptFrame(key, fileId, 2, false, flipped), FrameAuthError)
  assert.throws(() => decryptFrame(key, fileId, 3, false, f), FrameAuthError)
  assert.throws(() => decryptFrame(key, 'other', 2, false, f), FrameAuthError)
  assert.throws(() => decryptFrame(key, fileId, 2, true, f), FrameAuthError)
})
