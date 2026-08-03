import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { XMLParser } from 'fast-xml-parser'
import obj2gltf from 'obj2gltf'
import validator from 'gltf-validator'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const MODEL_ROOT = resolve(ROOT, 'src-tauri/resources/simulation/models/unitree-go2-menagerie')
export const UPSTREAM = resolve(MODEL_ROOT, 'upstream')
export const ASSETS = resolve(UPSTREAM, 'assets')
export const MENAGERIE_LOCK = resolve(MODEL_ROOT, 'menagerie.lock.json')
export const VISUAL_LOCK = resolve(ROOT, 'src/features/gaussian-viewer/robot/go2Visuals.lock.json')
export const GENERATED = resolve(ROOT, 'public/robot-visuals/unitree-go2/generated')
export const TEMP_ROOT = resolve(ROOT, '.cache/go2-visuals')
export const MENAGERIE_COMMIT = '71f066ad0be9cd271f7ed58c030243ef157af9f4'
export const GO2_XML_SHA256 = '50adb09a4365293e2acdaf2010ae35a82b0f09fea18ae51806fef91e310ed04a'
export const MAX_SOURCE_BYTES = 10 * 1024 * 1024
export const MAX_GLB_BYTES = 16 * 1024 * 1024
export const MAX_TOTAL_GLB_BYTES = 64 * 1024 * 1024

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
export const array = (value) => value === undefined ? [] : Array.isArray(value) ? value : [value]
export const numbers = (value, fallback) => value === undefined ? fallback : String(value).trim().split(/\s+/).map(Number)

export async function safeRegularFile(path, root) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`不安全的文件类型：${basename(path)}`)
  const rel = relative(root, path)
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || resolve(root, rel) !== path) throw new Error('文件路径越界')
  return info
}

export async function readAndVerifySources() {
  const lock = JSON.parse(await readFile(MENAGERIE_LOCK, 'utf8'))
  if (lock.commit !== MENAGERIE_COMMIT || lock.archiveSha256 !== '3c119c346de1457a9ceaeaee15958b7df78f0776b52a601dbd0323350a84a092') throw new Error('Menagerie 锁定信息不匹配')
  const xmlBytes = await readFile(resolve(UPSTREAM, 'go2.xml'))
  if (sha256(xmlBytes) !== GO2_XML_SHA256) throw new Error('官方 go2.xml 哈希不匹配')
  const recorded = new Map(lock.files.filter((item) => item.path.startsWith('upstream/assets/') && item.path.endsWith('.obj')).map((item) => [basename(item.path), item]))
  const names = (await readdir(ASSETS)).filter((name) => name.endsWith('.obj')).sort()
  if (names.length !== 16 || recorded.size !== 16 || names.some((name) => !recorded.has(name))) throw new Error('官方 OBJ 清单不是锁定的 16 个文件')
  const sources = []
  for (const name of names) {
    const path = resolve(ASSETS, name)
    const info = await safeRegularFile(path, ASSETS)
    if (info.size > MAX_SOURCE_BYTES) throw new Error(`OBJ 超过大小限制：${name}`)
    const bytes = await readFile(path)
    const expected = recorded.get(name)
    if (bytes.length !== expected.size || sha256(bytes) !== expected.sha256) throw new Error(`OBJ 哈希不匹配：${name}`)
    sources.push({ name, path, bytes, sha256: expected.sha256 })
  }
  return { lock, xmlBytes, sources }
}

function parseObj(text) {
  const stats = { vertexCount: 0, textureCoordinateCount: 0, normalCount: 0, faceCount: 0, objects: [], groups: [], smoothingGroups: [], faces: [] }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const [keyword, ...rest] = line.split(/\s+/)
    const value = rest.join(' ')
    if (keyword === 'v') { stats.vertexCount++; if (rest.slice(0, 3).some((part) => !Number.isFinite(Number(part)))) throw new Error('OBJ 顶点包含非有限数值') }
    else if (keyword === 'vt') stats.textureCoordinateCount++
    else if (keyword === 'vn') stats.normalCount++
    else if (keyword === 'f') { stats.faceCount++; stats.faces.push(value) }
    else if (keyword === 'o') stats.objects.push(value)
    else if (keyword === 'g') stats.groups.push(value)
    else if (keyword === 's') stats.smoothingGroups.push(value)
  }
  for (const face of stats.faces) for (const token of face.split(/\s+/)) {
    const [v, vt, vn] = token.split('/').map((item) => item === '' ? undefined : Number(item))
    if (!Number.isInteger(v) || v === 0 || Math.abs(v) > stats.vertexCount) throw new Error('OBJ 面顶点索引非法')
    if (vt !== undefined && (!Number.isInteger(vt) || vt === 0 || Math.abs(vt) > stats.textureCoordinateCount)) throw new Error('OBJ 面 UV 索引非法')
    if (vn !== undefined && (!Number.isInteger(vn) || vn === 0 || Math.abs(vn) > stats.normalCount)) throw new Error('OBJ 面法线索引非法')
  }
  return stats
}

export async function sanitizeObjForGeometryOnly(source, destination) {
  const text = source.bytes.toString('utf8')
  let mtllibLinesRemoved = 0; let usemtlLinesRemoved = 0
  const kept = []
  for (const line of text.split(/(?<=\n)/)) {
    const plain = line.replace(/[\r\n]+$/, '')
    if (/^\s*mtllib(?:\s|$)/i.test(plain)) { mtllibLinesRemoved++; continue }
    if (/^\s*usemtl(?:\s|$)/i.test(plain)) { usemtlLinesRemoved++; continue }
    kept.push(line)
  }
  const sanitized = kept.join('')
  if (/^\s*(?:mtllib|usemtl)(?:\s|$)/im.test(sanitized)) throw new Error(`临时 OBJ 仍含材质引用：${source.name}`)
  const originalStats = parseObj(text); const sanitizedStats = parseObj(sanitized)
  if (JSON.stringify(originalStats) !== JSON.stringify(sanitizedStats)) throw new Error(`geometry-only 一致性失败：${source.name}`)
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, sanitized, 'utf8')
  return { sourceSha256: source.sha256, sanitizedSha256: sha256(Buffer.from(sanitized)), mtllibLinesRemoved, usemtlLinesRemoved, ...sanitizedStats }
}

function findMaterialMap(root) {
  return new Map(array(root.mujoco.asset?.material).map((material) => [material.name, numbers(material.rgba, [0.5, 0.5, 0.5, 1])]))
}

export function parseModelManifest(xmlBytes) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', parseAttributeValue: false })
  const root = parser.parse(xmlBytes.toString('utf8'))
  const meshes = new Map(array(root.mujoco.asset?.mesh).map((mesh) => {
    const file = mesh.file
    const name = mesh.name ?? basename(file, extname(file))
    return [name, { meshAssetName: name, sourceObj: file, meshScale: numbers(mesh.scale, [1, 1, 1]) }]
  }))
  const materials = findMaterialMap(root)
  const parts = []
  function visit(body) {
    if (!body?.name) throw new Error('Go2 body 缺少名称')
    let meshIndex = 0
    for (const geom of array(body.geom)) {
      if (!geom.mesh) continue
      const mesh = meshes.get(geom.mesh)
      if (!mesh) throw new Error(`未知 mesh asset：${geom.mesh}`)
      const rgba = geom.rgba ? numbers(geom.rgba, null) : geom.material ? materials.get(geom.material) : null
      if (!rgba || rgba.length !== 4 || rgba.some((n) => !Number.isFinite(n))) throw new Error(`mesh geom 缺少有效颜色：${body.name}/${geom.mesh}`)
      parts.push({
        id: `${body.name}-${geom.mesh}-${meshIndex++}`,
        ...mesh,
        bodyName: body.name,
        geomName: geom.name ?? `${body.name}:${geom.mesh}`,
        geomPosition: numbers(geom.pos, [0, 0, 0]),
        geomOrientation: numbers(geom.quat, [1, 0, 0, 0]),
        material: geom.material ?? null,
        rgba,
      })
    }
    for (const child of array(body.body)) visit(child)
  }
  for (const body of array(root.mujoco.worldbody?.body)) visit(body)
  const referenced = new Set(parts.map((part) => part.meshAssetName))
  if (meshes.size !== 16 || referenced.size !== 16 || [...meshes.keys()].some((name) => !referenced.has(name))) throw new Error('mesh-to-body 映射不完整')
  return { meshes, parts, materials }
}

function inspectGlbJson(bytes) {
  if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'glTF' || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) throw new Error('GLB 头部无效')
  const jsonLength = bytes.readUInt32LE(12)
  const json = JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength).trim())
  const uris = []
  for (const item of [...(json.buffers ?? []), ...(json.images ?? [])]) if (item.uri) uris.push(item.uri)
  if (uris.length) throw new Error('GLB 包含外部 URI')
  if ((json.animations?.length ?? 0) || (json.skins?.length ?? 0) || (json.cameras?.length ?? 0)) throw new Error('GLB 包含意外场景内容')
  if ((json.extensionsUsed?.length ?? 0) || (json.extensionsRequired?.length ?? 0)) throw new Error('GLB 包含未知扩展')
  const finite = (json.accessors ?? []).every((accessor) => [...(accessor.min ?? []), ...(accessor.max ?? [])].every(Number.isFinite))
  if (!finite) throw new Error('GLB accessor 包含非有限边界')
  let vertices = 0; let triangles = 0; let primitives = 0
  for (const mesh of json.meshes ?? []) for (const primitive of mesh.primitives ?? []) {
    primitives++
    const position = json.accessors?.[primitive.attributes?.POSITION]
    const indices = json.accessors?.[primitive.indices]
    vertices += position?.count ?? 0
    triangles += indices ? Math.floor(indices.count / 3) : Math.floor((position?.count ?? 0) / 3)
  }
  return { json, vertices, triangles, primitives }
}

export async function validateGlb(bytes, name) {
  const inspected = inspectGlbJson(bytes)
  const result = await validator.validateBytes(new Uint8Array(bytes), { uri: name, maxIssues: 1000 })
  if (result.issues.numErrors !== 0) throw new Error(`glTF Validator 失败：${name} (${result.issues.numErrors} errors)`)
  return { errors: result.issues.numErrors, warnings: result.issues.numWarnings, messages: result.issues.messages, ...inspected }
}

export async function convertAll(runDirectory, sources, model) {
  const sanitizedDir = resolve(runDirectory, 'geometry-only')
  const outputDir = resolve(runDirectory, 'output')
  await mkdir(outputDir, { recursive: true })
  const outputs = []
  for (const source of sources) {
    const tempObj = resolve(sanitizedDir, source.name)
    const geometry = await sanitizeObjForGeometryOnly(source, tempObj)
    const glb = Buffer.from(await obj2gltf(tempObj, { binary: true, secure: true, logger: () => {} }))
    if (glb.length > MAX_GLB_BYTES) throw new Error(`单个 GLB 超限：${source.name}`)
    const outputName = `${basename(source.name, '.obj')}.glb`
    const validation = await validateGlb(glb, outputName)
    await writeFile(resolve(outputDir, outputName), glb)
    const mesh = [...model.meshes.values()].find((item) => item.sourceObj === source.name)
    outputs.push({ source, geometry, outputName, glb, glbSha256: sha256(glb), byteSize: glb.length, meshAssetName: mesh.meshAssetName, validation })
  }
  const total = outputs.reduce((sum, item) => sum + item.byteSize, 0)
  if (total > MAX_TOTAL_GLB_BYTES) throw new Error('GLB 总大小超过 64 MiB')
  return { outputDir, outputs, total }
}

export function createLock(model, outputs) {
  const bySource = new Map(outputs.map((item) => [item.source.name, item]))
  return {
    schemaVersion: 1,
    modelId: 'unitree-go2-menagerie',
    menagerieCommit: MENAGERIE_COMMIT,
    go2XmlSha256: GO2_XML_SHA256,
    generator: { name: 'obj2gltf', version: '3.2.0', options: { binary: true, secure: true, geometryOnly: true }, validator: { name: 'gltf-validator', version: '2.0.0-dev.3.10' } },
    coordinateStrategy: 'OBJ vertices remain in MuJoCo local coordinates; runtime applies local transform C*R_geom with C=Rx(-90deg), while body FK already uses the conjugated PlayCanvas basis.',
    materials: [...model.materials].map(([name, rgba]) => ({ name, rgba })),
    sources: outputs.map((item) => ({
      sourceObj: item.source.name, sourceSha256: item.source.sha256,
      sanitizedSha256: item.geometry.sanitizedSha256,
      mtllibLinesRemoved: item.geometry.mtllibLinesRemoved, usemtlLinesRemoved: item.geometry.usemtlLinesRemoved,
      vertexCount: item.geometry.vertexCount, normalCount: item.geometry.normalCount,
      textureCoordinateCount: item.geometry.textureCoordinateCount, faceCount: item.geometry.faceCount,
      outputGlb: item.outputName, glbSha256: item.glbSha256, byteSize: item.byteSize,
      meshAssetName: item.meshAssetName, validator: { errors: item.validation.errors, warnings: item.validation.warnings },
    })),
    parts: model.parts.map((part) => {
      const output = bySource.get(part.sourceObj)
      return { ...part, glbUrl: `/robot-visuals/unitree-go2/generated/${output.outputName}`, sourceSha256: output.source.sha256, glbSha256: output.glbSha256, byteSize: output.byteSize }
    }),
  }
}

export async function readVisualLock() { return JSON.parse(await readFile(VISUAL_LOCK, 'utf8')) }
export async function writeJson(path, value) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8') }
export async function replaceGenerated(outputDir, manifest) {
  const replacement = resolve(TEMP_ROOT, 'generated-ready')
  await rm(replacement, { recursive: true, force: true }); await mkdir(replacement, { recursive: true })
  for (const name of await readdir(outputDir)) await writeFile(resolve(replacement, name), await readFile(resolve(outputDir, name)))
  await writeJson(resolve(replacement, 'generated-manifest.json'), manifest)
  const old = resolve(TEMP_ROOT, 'generated-old')
  await rm(old, { recursive: true, force: true }); await mkdir(dirname(GENERATED), { recursive: true })
  try { await rename(GENERATED, old) } catch (error) { if (error.code !== 'ENOENT') throw error }
  try { await rename(replacement, GENERATED); await rm(old, { recursive: true, force: true }) }
  catch (error) { try { await rename(old, GENERATED) } catch {}; throw error }
}

export function runtimeManifest(lock) {
  return { schemaVersion: lock.schemaVersion, modelId: lock.modelId, menagerieCommit: lock.menagerieCommit, parts: lock.parts }
}

export async function cleanTemp() { await rm(TEMP_ROOT, { recursive: true, force: true }) }
