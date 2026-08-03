import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import {
  GENERATED, parseModelManifest, readAndVerifySources, readVisualLock,
  sanitizeObjForGeometryOnly, sha256, validateGlb,
} from './go2-visuals-lib.mjs'

test('fixed Menagerie sources and all 16 OBJ hashes are valid', async () => {
  const { lock, sources } = await readAndVerifySources()
  assert.equal(lock.commit, '71f066ad0be9cd271f7ed58c030243ef157af9f4')
  assert.equal(sources.length, 16)
  assert.equal(new Set(sources.map((item) => item.sha256)).size, 16)
})

test('sanitizer removes only one mtllib and usemtl line from every OBJ', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'go2-sanitize-'))
  try {
    const { sources } = await readAndVerifySources()
    for (const source of sources) {
      const destination = resolve(directory, source.name)
      const result = await sanitizeObjForGeometryOnly(source, destination)
      const text = await readFile(destination, 'utf8')
      assert.equal(result.mtllibLinesRemoved, 1); assert.equal(result.usemtlLinesRemoved, 1)
      assert.doesNotMatch(text, /^\s*(?:mtllib|usemtl)(?:\s|$)/im)
      assert.ok(result.vertexCount > 0); assert.ok(result.normalCount > 0); assert.ok(result.faceCount > 0)
      assert.equal(sha256(source.bytes), source.sha256)
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('XML maps 16 mesh assets to 33 trusted body geom instances', async () => {
  const { xmlBytes } = await readAndVerifySources(); const model = parseModelManifest(xmlBytes)
  assert.equal(model.meshes.size, 16); assert.equal(model.parts.length, 33)
  assert.deepEqual([...model.materials.keys()], ['metal', 'black', 'white', 'gray'])
  assert.equal(model.parts.filter((part) => part.bodyName === 'base').length, 5)
  assert.equal(model.parts.filter((part) => part.sourceObj === 'foot.obj').length, 4)
  assert.ok(model.parts.every((part) => part.meshScale.join(',') === '1,1,1'))
})

test('generated GLBs exactly match the committed visual lock and validator', async () => {
  const lock = await readVisualLock()
  assert.equal(lock.sources.length, 16)
  for (const entry of lock.sources) {
    const bytes = await readFile(resolve(GENERATED, entry.outputGlb))
    assert.equal(sha256(bytes), entry.glbSha256)
    const validation = await validateGlb(bytes, entry.outputGlb)
    assert.equal(validation.errors, 0); assert.equal(validation.warnings, 0)
  }
})
