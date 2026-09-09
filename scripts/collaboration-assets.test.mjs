import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, copyFile, writeFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

test('collaboration bundle verifies bytes, preserves config and detects tampering', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'collaboration-assets-'))
  await mkdir(resolve(root, 'scripts'))
  await copyFile(new URL('./collaboration-assets.mjs', import.meta.url), resolve(root, 'scripts/collaboration-assets.mjs'))
  const run = (...args) => spawnSync(process.execPath, [resolve(root, 'scripts/collaboration-assets.mjs'), ...args], { encoding: 'utf8', windowsHide: true })
  const source = resolve(root, 'source'), archive = resolve(root, 'bundle.json.gz')
  await mkdir(source)
  await writeFile(resolve(source, 'scene_yup.sog'), 'fixture scene')
  for (const route of ['fire_playback/table_high', 'fire_playback_room/sofa_high', 'fire_playback_room/curtain_high', 'fire_playback_v2/table_high_test']) {
    await mkdir(resolve(source, route), { recursive: true })
    for (const name of ['metadata.json', 'frames_000.bin', 'thermal.json', 'thermal_000.bin']) await writeFile(resolve(source, route, name), '{}')
  }
  assert.equal(run('pack', source, archive).status, 0)
  const corrupt = resolve(root, 'bad.json.gz')
  await writeFile(corrupt, 'corrupt')
  assert.match(run('setup', corrupt).stderr, /Bundle hash mismatch/)
  await writeFile(resolve(root, '.env.local'), 'VITE_DATA_SOURCE=mock\nGS_SCENE_DATA_ROOT=old\n')
  const installed = run('setup', archive)
  assert.equal(installed.status, 0, installed.stderr)
  assert.equal(run('verify').status, 0)
  assert.equal(run('setup').status, 0)
  const env = await readFile(resolve(root, '.env.local'), 'utf8')
  assert.match(env, /VITE_DATA_SOURCE=mock/)
  assert.equal(env.match(/^GS_SCENE_DATA_ROOT=/gm).length, 1)
  const lock = JSON.parse(await readFile(resolve(root, 'assets/collaboration.lock.json')))
  await writeFile(resolve(root, 'data/collaboration', lock.sha256, 'office_01/scene_yup.sog'), 'tampered')
  assert.match(run('verify').stderr, /Asset hash mismatch/)
})
