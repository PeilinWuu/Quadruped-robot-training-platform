import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  GENERATED, MAX_TOTAL_GLB_BYTES, parseModelManifest, readAndVerifySources,
  readVisualLock, runtimeManifest, sha256, validateGlb,
} from './go2-visuals-lib.mjs'

try {
  const { xmlBytes, sources } = await readAndVerifySources(); const model = parseModelManifest(xmlBytes); const lock = await readVisualLock()
  if (lock.schemaVersion !== 1 || lock.modelId !== 'unitree-go2-menagerie' || lock.sources.length !== 16 || lock.parts.length !== model.parts.length) throw new Error('视觉锁文件 schema 或映射无效')
  const expected = new Set(lock.sources.map((item) => item.outputGlb))
  const files = (await readdir(GENERATED)).sort(); const actual = files.filter((name) => name.endsWith('.glb'))
  if (actual.length !== 16 || actual.some((name) => !expected.has(name)) || files.some((name) => name !== 'generated-manifest.json' && !expected.has(name))) throw new Error('生成目录含缺失或多余文件')
  let total = 0
  for (const entry of lock.sources) {
    const source = sources.find((item) => item.name === entry.sourceObj)
    if (!source || source.sha256 !== entry.sourceSha256) throw new Error(`源 OBJ 锁不匹配：${entry.sourceObj}`)
    const bytes = await readFile(resolve(GENERATED, entry.outputGlb)); total += bytes.length
    if (bytes.length !== entry.byteSize || sha256(bytes) !== entry.glbSha256) throw new Error(`GLB 哈希不匹配：${entry.outputGlb}`)
    const validation = await validateGlb(bytes, entry.outputGlb)
    if (validation.warnings !== entry.validator.warnings) throw new Error(`Validator warning 变化：${entry.outputGlb}`)
  }
  if (total > MAX_TOTAL_GLB_BYTES) throw new Error('GLB 总大小超过 64 MiB')
  const manifest = JSON.parse(await readFile(resolve(GENERATED, 'generated-manifest.json'), 'utf8'))
  if (JSON.stringify(manifest) !== JSON.stringify(runtimeManifest(lock))) throw new Error('generated-manifest 与锁文件不一致')
  if ((await readdir(GENERATED)).some((name) => name.toLowerCase().endsWith('.sog'))) throw new Error('生成目录混入 SOG')
  console.log(`Go2 网格离线验证通过：16 个 GLB，${total} 字节，0 validator error`)
} catch (error) { console.error(`Go2 网格验证失败：${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1 }
