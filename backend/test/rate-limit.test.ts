import assert from 'node:assert/strict'
import test from 'node:test'
import { createLoginLimiter } from '../src/utils/rate-limit.js'

test('allows 5 failures, blocks the 6th', () => {
  const l = createLoginLimiter(5, 1000)
  for (let i = 0; i < 5; i++) assert.equal(l.check('k', 0), true)
  assert.equal(l.check('k', 0), false)
})
test('unblocks after window', () => {
  const l = createLoginLimiter(5, 1000)
  for (let i = 0; i < 6; i++) l.check('k', 0)
  assert.equal(l.check('k', 1001), true)
})
test('reset clears', () => {
  const l = createLoginLimiter(5, 1000)
  for (let i = 0; i < 6; i++) l.check('k', 0)
  l.reset('k')
  assert.equal(l.check('k', 0), true)
})
