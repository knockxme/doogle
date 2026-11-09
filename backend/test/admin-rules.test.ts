import assert from 'node:assert/strict'
import test from 'node:test'
import { assertNotLastAdmin } from '../src/modules/admin/admin-rules.js'

test('last active admin cannot be removed', () => {
  assert.throws(() => assertNotLastAdmin(1, { role: 'admin', status: 'active' }), (e: any) => e.code === 'LAST_ADMIN')
})
test('two admins allows removal', () => {
  assert.doesNotThrow(() => assertNotLastAdmin(2, { role: 'admin', status: 'active' }))
})
test('member target passes', () => {
  assert.doesNotThrow(() => assertNotLastAdmin(1, { role: 'member', status: 'active' }))
})
