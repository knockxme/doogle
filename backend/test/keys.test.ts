import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'
import {
  deriveUserKey,
  masterFingerprint,
  newFileKey,
  parseMasterKey,
  unwrapFileKey,
} from '../src/modules/crypto/keys.js'

const master = crypto.randomBytes(32)

test('user keys differ by user and are stable', () => {
  assert.ok(!deriveUserKey(master, 'a').equals(deriveUserKey(master, 'b')))
  assert.ok(deriveUserKey(master, 'a').equals(deriveUserKey(master, 'a')))
  assert.equal(deriveUserKey(master, 'a').length, 32)
})

test('file key wrap round trip', () => {
  const uk = deriveUserKey(master, 'a')
  const { fileKey, wrapped } = newFileKey(uk)
  assert.equal(fileKey.length, 32)
  assert.ok(unwrapFileKey(uk, wrapped).equals(fileKey))
})

test('unwrap under another user key throws', () => {
  const { wrapped } = newFileKey(deriveUserKey(master, 'a'))
  assert.throws(() => unwrapFileKey(deriveUserKey(master, 'b'), wrapped))
})

test('parseMasterKey', () => {
  assert.ok(parseMasterKey(master.toString('base64')).equals(master))
  assert.throws(() => parseMasterKey(crypto.randomBytes(31).toString('base64')))
})

test('fingerprint does not leak key', () => {
  const fp = masterFingerprint(master)
  assert.ok(!fp.includes(master.toString('hex')))
  assert.match(fp, /^[0-9a-f]{64}$/)
})
