import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const root = new URL('../public/robot-motion/solo8_walk/', import.meta.url)

test('Kine2Go solo8_walk browser asset is complete and rig-compatible', async () => {
  const metadata = JSON.parse(await readFile(new URL('metadata.json', root), 'utf8'))
  const frames = await readFile(new URL('frames.bin', root))
  const license = await readFile(new URL('LICENSE.txt', root), 'utf8')
  assert.equal(metadata.schema, 'go2-motion-playback-v1')
  assert.equal(metadata.source.license, 'BSD-3-Clause')
  assert.match(license, /Redistribution and use in source and binary forms/)
  assert.equal(frames.byteLength, metadata.frameCount * metadata.frameBytes)
  assert.deepEqual(metadata.jointOrder, [
    'FL_hip_joint', 'FL_thigh_joint', 'FL_calf_joint',
    'FR_hip_joint', 'FR_thigh_joint', 'FR_calf_joint',
    'RL_hip_joint', 'RL_thigh_joint', 'RL_calf_joint',
    'RR_hip_joint', 'RR_thigh_joint', 'RR_calf_joint',
  ])
  const values = new Float32Array(frames.buffer, frames.byteOffset, frames.byteLength / 4)
  assert.ok(values.every(Number.isFinite))
  assert.ok(metadata.frameCount >= 60)
})
