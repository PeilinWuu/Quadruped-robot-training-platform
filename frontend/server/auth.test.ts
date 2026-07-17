import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionToken, hashPassword, hashToken, validatePassword, verifyPassword } from './auth.ts'

test('password hash verifies only the original password', async () => {
  const hash = await hashPassword('FireRobot2026')
  assert.equal(await verifyPassword('FireRobot2026', hash), true)
  assert.equal(await verifyPassword('WrongPassword1', hash), false)
  assert.notEqual(hash, 'FireRobot2026')
})

test('password policy requires length, letters and numbers', () => {
  assert.ok(validatePassword('short1'))
  assert.ok(validatePassword('onlyletters'))
  assert.equal(validatePassword('ValidFire2026'), null)
})

test('session tokens are random and stored as hashes', () => {
  const first = createSessionToken(); const second = createSessionToken()
  assert.notEqual(first, second); assert.notEqual(hashToken(first), first); assert.equal(hashToken(first).length, 64)
})
