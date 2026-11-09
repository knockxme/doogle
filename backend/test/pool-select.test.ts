import assert from 'node:assert/strict'
import test from 'node:test'
import { effectiveFree, pickPair, usablePoolBytes, type Candidate } from '../src/modules/storage/pool-select.js'

const GB = 1024n ** 3n
const now = new Date('2026-11-10T12:00:00Z')
let n = 0
function cand(over: Partial<Candidate> = {}): Candidate {
  n += 1
  return {
    id: `a${n}`,
    provider: 'google_drive',
    createdAt: new Date(2026, 0, n),
    capBytes: null,
    appStoredBytes: 0n,
    providerFreeBytes: 100n * GB,
    reservedBytes: 0n,
    pausedUntil: null,
    ...over,
  }
}
const mostAvailable = { mode: 'most_available' as const, priorityAccountIds: [], cursor: 0 }

test('effectiveFree takes the lower of cap room and provider free', () => {
  assert.equal(effectiveFree(cand({ capBytes: 20n * GB, appStoredBytes: 19n * GB, providerFreeBytes: 100n * GB })), 1n * GB)
})
test('effectiveFree with no cap uses provider free', () => {
  assert.equal(effectiveFree(cand({ capBytes: null, providerFreeBytes: 5n * GB })), 5n * GB)
})
test('effectiveFree subtracts reserved bytes', () => {
  assert.equal(effectiveFree(cand({ capBytes: null, providerFreeBytes: 5n * GB, reservedBytes: 2n * GB })), 3n * GB)
})
test('effectiveFree is zero when cap is below stored', () => {
  assert.equal(effectiveFree(cand({ capBytes: 1n * GB, appStoredBytes: 3n * GB })), 0n)
})
test('effectiveFree is null when both are unknown', () => {
  assert.equal(effectiveFree(cand({ capBytes: null, providerFreeBytes: null })), null)
})
test('effectiveFree uses cap room when provider free is unknown', () => {
  assert.equal(effectiveFree(cand({ capBytes: 10n * GB, appStoredBytes: 4n * GB, providerFreeBytes: null })), 6n * GB)
})

test('pickPair returns two distinct ids', () => {
  const pair = pickPair([cand(), cand(), cand()], 1n, mostAvailable, now)
  assert.ok(pair)
  assert.notEqual(pair[0], pair[1])
})
test('pickPair returns null with one eligible account', () => {
  assert.equal(pickPair([cand()], 1n, mostAvailable, now), null)
  assert.equal(pickPair([cand(), cand({ capBytes: 1n, appStoredBytes: 5n })], 1n, mostAvailable, now), null)
})
test('paused account is skipped until pausedUntil passes', () => {
  const a = cand(), b = cand(), c = cand({ pausedUntil: new Date(now.getTime() + 60_000) })
  assert.equal(pickPair([a, b, c], 1n, mostAvailable, now)?.includes(c.id), false)
  assert.equal(pickPair([a, c], 1n, mostAvailable, now), null)
  const later = new Date(now.getTime() + 120_000)
  assert.ok(pickPair([a, c], 1n, mostAvailable, later))
})
test('account lacking room is skipped', () => {
  const a = cand(), b = cand(), small = cand({ providerFreeBytes: 10n })
  const pair = pickPair([small, a, b], 100n, mostAvailable, now)
  assert.ok(pair)
  assert.equal(pair.includes(small.id), false)
})
test('most_available picks the two largest', () => {
  const a = cand({ providerFreeBytes: 10n * GB }), b = cand({ providerFreeBytes: 50n * GB }), c = cand({ providerFreeBytes: 30n * GB })
  assert.deepEqual(pickPair([a, b, c], 1n, mostAvailable, now), [b.id, c.id])
})
test('most_available prefers unlimited s3 first, unlimited others last', () => {
  const a = cand({ providerFreeBytes: 10n * GB }), s3 = cand({ provider: 's3', providerFreeBytes: null }), g = cand({ providerFreeBytes: null })
  assert.deepEqual(pickPair([g, a, s3], 1n, mostAvailable, now), [s3.id, a.id])
})
test('priority follows the configured order, then creation order', () => {
  const a = cand(), b = cand(), c = cand()
  assert.deepEqual(pickPair([a, b, c], 1n, { mode: 'priority', priorityAccountIds: [c.id, b.id], cursor: 0 }, now), [c.id, b.id])
  assert.deepEqual(pickPair([c, b, a], 1n, { mode: 'priority', priorityAccountIds: [c.id], cursor: 0 }, now), [c.id, a.id])
})
test('round_robin advances with the cursor', () => {
  const a = cand(), b = cand(), c = cand()
  const policy = (cursor: number) => ({ mode: 'round_robin' as const, priorityAccountIds: [], cursor })
  assert.deepEqual(pickPair([a, b, c], 1n, policy(0), now), [a.id, b.id])
  assert.deepEqual(pickPair([a, b, c], 1n, policy(1), now), [b.id, c.id])
  assert.deepEqual(pickPair([a, b, c], 1n, policy(2), now), [c.id, a.id])
  assert.deepEqual(pickPair([a, b, c], 1n, policy(3), now), [a.id, b.id])
})

test('usablePoolBytes sums effective free of unpaused accounts', () => {
  const a = cand({ providerFreeBytes: 5n * GB }), b = cand({ providerFreeBytes: 7n * GB }), p = cand({ pausedUntil: new Date(now.getTime() + 1000) })
  assert.equal(usablePoolBytes([a, b, p], now), 12n * GB)
  assert.equal(usablePoolBytes([], now), 0n)
})
test('usablePoolBytes is null when any usable account is unlimited', () => {
  assert.equal(usablePoolBytes([cand(), cand({ providerFreeBytes: null })], now), null)
})
