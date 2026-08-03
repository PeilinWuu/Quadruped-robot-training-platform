import { mkdir, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  TEMP_ROOT, VISUAL_LOCK, cleanTemp, convertAll, createLock, parseModelManifest,
  readAndVerifySources, replaceGenerated, runtimeManifest, writeJson,
} from './go2-visuals-lib.mjs'

const updateLock = process.argv.includes('--update-lock')
try {
  await cleanTemp(); await mkdir(TEMP_ROOT, { recursive: true })
  const { xmlBytes, sources } = await readAndVerifySources()
  const model = parseModelManifest(xmlBytes)
  const first = await convertAll(resolve(TEMP_ROOT, 'run-a'), sources, model)
  const second = await convertAll(resolve(TEMP_ROOT, 'run-b'), sources, model)
  for (let index = 0; index < first.outputs.length; index++) {
    if (!first.outputs[index].glb.equals(second.outputs[index].glb)) throw new Error(`两次转换不一致：${first.outputs[index].outputName}`)
  }
  const generatedLock = createLock(model, first.outputs)
  if (updateLock) await writeJson(VISUAL_LOCK, generatedLock)
  else {
    const committed = JSON.parse(await readFile(VISUAL_LOCK, 'utf8'))
    if (JSON.stringify(committed) !== JSON.stringify(generatedLock)) throw new Error('生成结果与 go2Visuals.lock.json 不匹配')
  }
  await replaceGenerated(first.outputDir, runtimeManifest(generatedLock))
  console.log(`Go2 网格构建通过：${first.outputs.length} 个 GLB，${first.total} 字节，两次转换逐字节一致`)
} catch (error) {
  console.error(`Go2 网格构建失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally { await rm(TEMP_ROOT, { recursive: true, force: true }) }
