import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const main = readFileSync(new URL('../electron-poc/main.cjs', import.meta.url), 'utf8')
const preload = readFileSync(new URL('../electron-poc/preload.cjs', import.meta.url), 'utf8')
const launcher = readFileSync(new URL('../electron-poc/launcher.mjs', import.meta.url), 'utf8')

test('Electron POC keeps a sandboxed minimal renderer boundary', () => {
  assert.match(main, /nodeIntegration:\s*false/)
  assert.match(main, /contextIsolation:\s*true/)
  assert.match(main, /sandbox:\s*true/)
  assert.doesNotMatch(preload, /\brequire\(['"](?:node:)?(?:fs|child_process)/)
  assert.match(preload, /d6-poc:versions/)
})

test('Electron POC uses an isolated dynamic local port and never spawns product backends', () => {
  assert.match(launcher, /server\.listen\(0, '127\.0\.0\.1'/)
  assert.doesNotMatch(main + preload + launcher, /quadruped-simulation-sidecar|quadruped_ros_bridge/)
})
