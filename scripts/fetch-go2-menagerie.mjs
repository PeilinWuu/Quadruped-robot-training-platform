import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import {
  closeSync, copyFileSync, createWriteStream, existsSync, mkdirSync, openSync,
  readFileSync, readSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import {
  MODEL_ID, REPOSITORY, assertSafeRelative, lockPath, modelRoot, repositoryRoot,
  sha256File, verifyFormalResources, walkFiles, posixRelative, xmlFileReferences,
} from './go2-menagerie-lib.mjs'

const MAX_ARCHIVE_BYTES = 768 * 1024 * 1024
const REQUIRED_DOCUMENTS = ['README.md', 'CHANGELOG.md', 'LICENSE', 'go2.xml']
const EXPECTED_MESHES = [
  'base_0.obj', 'base_1.obj', 'base_2.obj', 'base_3.obj', 'base_4.obj',
  'hip_0.obj', 'hip_1.obj', 'thigh_0.obj', 'thigh_1.obj',
  'thigh_mirror_0.obj', 'thigh_mirror_1.obj', 'calf_0.obj', 'calf_1.obj',
  'calf_mirror_0.obj', 'calf_mirror_1.obj', 'foot.obj',
]

function gitMainCommit() {
  const result = spawnSync('git', ['ls-remote', REPOSITORY, 'refs/heads/main'], { cwd: repositoryRoot, encoding: 'utf8', windowsHide: true, shell: false })
  if (result.status !== 0) throw new Error('GO2_REMOTE_UNAVAILABLE')
  const commit = result.stdout.trim().split(/\s+/)[0]
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('GO2_REMOTE_COMMIT_INVALID')
  return commit
}
async function download(url, target) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) })
  if (!response.ok || !response.body) throw new Error(`GO2_DOWNLOAD_FAILED:${response.status}`)
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > MAX_ARCHIVE_BYTES) throw new Error('GO2_ARCHIVE_TOO_LARGE')
  const temporary = `${target}.partial`
  const output = createWriteStream(temporary, { flags: 'wx' })
  const hash = createHash('sha256'); let received = 0
  try {
    for await (const chunk of response.body) {
      received += chunk.length
      if (received > MAX_ARCHIVE_BYTES) throw new Error('GO2_ARCHIVE_TOO_LARGE')
      hash.update(chunk)
      if (!output.write(chunk)) await new Promise((resolve) => output.once('drain', resolve))
    }
    await new Promise((resolve, reject) => output.end((error) => error ? reject(error) : resolve()))
    renameSync(temporary, target)
    return hash.digest('hex')
  } catch (error) {
    output.destroy()
    if (existsSync(temporary)) unlinkSync(temporary)
    throw error
  }
}
function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}
function readAt(handle, length, position) {
  const buffer = Buffer.alloc(length)
  if (readSync(handle, buffer, 0, length, position) !== length) throw new Error('GO2_ARCHIVE_TRUNCATED')
  return buffer
}
function extractGo2(archivePath, commit, targetRoot) {
  const handle = openSync(archivePath, 'r')
  const archiveSize = statSync(archivePath).size
  const tailSize = Math.min(archiveSize, 65557)
  const tail = readAt(handle, tailSize, archiveSize - tailSize)
  const eocdSignature = 0x06054b50
  let eocd = -1
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) === eocdSignature) { eocd = offset; break }
  }
  if (eocd < 0) throw new Error('GO2_ARCHIVE_EOCD_MISSING')
  const entries = tail.readUInt16LE(eocd + 10)
  const centralSize = tail.readUInt32LE(eocd + 12)
  const centralOffset = tail.readUInt32LE(eocd + 16)
  if (centralSize > 32 * 1024 * 1024 || centralOffset + centralSize > archiveSize) throw new Error('GO2_ARCHIVE_CENTRAL_DIRECTORY_INVALID')
  const central = readAt(handle, centralSize, centralOffset)
  let offset = 0
  const prefix = `mujoco_menagerie-${commit}/unitree_go2/`
  let extracted = 0
  try {
    for (let index = 0; index < entries; index += 1) {
      if (central.readUInt32LE(offset) !== 0x02014b50) throw new Error('GO2_ARCHIVE_CENTRAL_DIRECTORY_INVALID')
      const method = central.readUInt16LE(offset + 10)
      const expectedCrc = central.readUInt32LE(offset + 16)
      const compressedSize = central.readUInt32LE(offset + 20)
      const uncompressedSize = central.readUInt32LE(offset + 24)
      const nameLength = central.readUInt16LE(offset + 28)
      const extraLength = central.readUInt16LE(offset + 30)
      const commentLength = central.readUInt16LE(offset + 32)
      const externalAttributes = central.readUInt32LE(offset + 38)
      const localOffset = central.readUInt32LE(offset + 42)
      const entryPath = central.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
      if (entryPath.includes('\\') || entryPath.startsWith('/') || entryPath.split('/').includes('..')) throw new Error('GO2_ARCHIVE_PATH_TRAVERSAL')
      const unixMode = externalAttributes >>> 16
      if ((unixMode & 0o170000) === 0o120000) throw new Error('GO2_ARCHIVE_SYMLINK_REJECTED')
      if (entryPath.startsWith(prefix) && !entryPath.endsWith('/')) {
        const relativePath = entryPath.slice(prefix.length)
        assertSafeRelative(relativePath, 'archive path')
        if (uncompressedSize > 32 * 1024 * 1024 || compressedSize > 32 * 1024 * 1024) throw new Error('GO2_ARCHIVE_ENTRY_TOO_LARGE')
        const localHeader = readAt(handle, 30, localOffset)
        if (localHeader.readUInt32LE(0) !== 0x04034b50) throw new Error('GO2_ARCHIVE_LOCAL_HEADER_INVALID')
        const localNameLength = localHeader.readUInt16LE(26)
        const localExtraLength = localHeader.readUInt16LE(28)
        const dataOffset = localOffset + 30 + localNameLength + localExtraLength
        const compressed = readAt(handle, compressedSize, dataOffset)
        const bytes = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : null
        if (!bytes || bytes.length !== uncompressedSize || crc32(bytes) !== expectedCrc) throw new Error('GO2_ARCHIVE_ENTRY_INVALID')
        const target = join(targetRoot, ...relativePath.split('/'))
        mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes); extracted += 1
      }
      offset += 46 + nameLength + extraLength + commentLength
    }
  } finally {
    closeSync(handle)
  }
  if (extracted === 0) throw new Error('GO2_DIRECTORY_NOT_FOUND_IN_ARCHIVE')
}
function writeJson(path, value) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`) }

async function main() {
  if (existsSync(lockPath)) {
    const existing = JSON.parse(readFileSync(lockPath, 'utf8'))
    if (existing.status === 'ready') { verifyFormalResources(); return }
    if (existing.repository !== REPOSITORY || !/^[0-9a-f]{40}$/.test(existing.commit)) throw new Error('GO2_PENDING_LOCK_INVALID')
  } else {
    const commit = gitMainCommit()
    writeJson(lockPath, {
      status: 'resolving', repository: REPOSITORY, commit,
      resolvedAt: new Date().toISOString(),
      archiveUrl: `https://github.com/google-deepmind/mujoco_menagerie/archive/${commit}.zip`,
      archiveSha256: null, modelDirectory: 'unitree_go2', modelId: MODEL_ID,
      upstreamLicense: 'BSD-3-Clause', requiredFiles: [], files: [],
    })
  }
  const pending = JSON.parse(readFileSync(lockPath, 'utf8'))
  const cacheRoot = join(repositoryRoot, '.cache', 'mujoco-menagerie', pending.commit)
  const archivePath = join(cacheRoot, 'archive.zip')
  mkdirSync(cacheRoot, { recursive: true })
  const archiveSha256 = existsSync(archivePath) ? sha256File(archivePath) : await download(pending.archiveUrl, archivePath)
  if (pending.archiveSha256 && pending.archiveSha256 !== archiveSha256) throw new Error('GO2_ARCHIVE_HASH_MISMATCH')
  pending.archiveSha256 = archiveSha256; writeJson(lockPath, pending)
  const extractedRoot = join(cacheRoot, 'unitree_go2')
  if (!existsSync(extractedRoot)) {
    const extractionStaging = join(cacheRoot, 'extract-staging')
    rmSync(extractionStaging, { recursive: true, force: true }); mkdirSync(extractionStaging, { recursive: true })
    extractGo2(archivePath, pending.commit, extractionStaging)
    renameSync(extractionStaging, extractedRoot)
  }
  for (const file of [...REQUIRED_DOCUMENTS, 'scene.xml']) if (!existsSync(join(extractedRoot, file))) throw new Error(`GO2_UPSTREAM_FILE_MISSING:${file}`)
  const license = readFileSync(join(extractedRoot, 'LICENSE'), 'utf8')
  if (!license.includes('Copyright (c) 2016-2022 HangZhou YuShu TECHNOLOGY CO.,LTD.') || !license.includes('Neither the name of the copyright holder')) throw new Error('GO2_LICENSE_REVIEW_FAILED')
  const xml = readFileSync(join(extractedRoot, 'go2.xml'), 'utf8')
  const meshFiles = xmlFileReferences(xml).filter(({ kind }) => kind === 'mesh').map(({ file }) => file)
  const textureFiles = xmlFileReferences(xml).filter(({ kind }) => kind === 'texture').map(({ file }) => file)
  if (JSON.stringify(meshFiles) !== JSON.stringify(EXPECTED_MESHES) || textureFiles.length !== 0) throw new Error('GO2_XML_DEPENDENCIES_CHANGED')
  for (const file of meshFiles) { assertSafeRelative(file, 'mesh path'); if (!existsSync(join(extractedRoot, 'assets', file))) throw new Error(`GO2_MESH_MISSING:${file}`) }
  const staging = join(dirname(modelRoot), `${MODEL_ID}.staging`)
  rmSync(staging, { recursive: true, force: true }); mkdirSync(join(staging, 'upstream', 'assets'), { recursive: true })
  for (const file of REQUIRED_DOCUMENTS) copyFileSync(join(extractedRoot, file), join(staging, 'upstream', file))
  for (const file of meshFiles) copyFileSync(join(extractedRoot, 'assets', file), join(staging, 'upstream', 'assets', file))
  const wrapper = `<mujoco model="unitree go2 project scene">\n  <include file="upstream/go2.xml"/>\n  <compiler meshdir="upstream/assets"/>\n\n  <visual>\n    <headlight diffuse="0.6 0.6 0.6" ambient="0.3 0.3 0.3" specular="0 0 0"/>\n  </visual>\n  <worldbody>\n    <light pos="0 0 1.5" dir="0 0 -1" directional="true"/>\n    <geom name="floor" size="0 0 0.05" type="plane" rgba="0.16 0.20 0.23 1"/>\n  </worldbody>\n</mujoco>\n`
  writeFileSync(join(staging, 'unitree-go2-scene.xml'), wrapper)
  const source = `# Unitree Go2 model source\n\n- Repository: ${REPOSITORY}\n- Commit: ${pending.commit}\n- Upstream directory: unitree_go2/\n- Retrieved: ${pending.resolvedAt}\n- License: BSD-3-Clause (see upstream/LICENSE)\n\nThe files under upstream/ are copied byte-for-byte from the fixed upstream commit. Only go2.xml and its 16 referenced OBJ meshes are included, together with README.md, CHANGELOG.md, and LICENSE. Preview PNG and MJX files are intentionally excluded.\n\nunitree-go2-scene.xml is project-owned. It includes the unmodified upstream/go2.xml, resolves the official meshes from upstream/assets, and adds only a floor, light, and headlight. The upstream home keyframe is reused without modification.\n`
  writeFileSync(join(staging, 'SOURCE.md'), source)
  const files = walkFiles(staging).map((path) => ({ path: posixRelative(staging, path), size: statSync(path).size, sha256: sha256File(path) }))
  const lock = { ...pending, status: 'ready', requiredFiles: [...REQUIRED_DOCUMENTS.map((file) => `upstream/${file}`), ...meshFiles.map((file) => `upstream/assets/${file}`)], files }
  writeJson(join(staging, 'menagerie.lock.json'), lock)
  const existingNames = existsSync(modelRoot) ? walkFiles(modelRoot).map((path) => posixRelative(modelRoot, path)) : []
  if (existingNames.some((path) => path !== 'menagerie.lock.json')) throw new Error('GO2_FORMAL_DIRECTORY_NOT_EMPTY')
  rmSync(modelRoot, { recursive: true, force: true }); renameSync(staging, modelRoot)
  verifyFormalResources()
}

main().catch((error) => { console.error(`Go2 setup failed: ${error instanceof Error ? error.message : 'UNKNOWN'}`); process.exitCode = 1 })
