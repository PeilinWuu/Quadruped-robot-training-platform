import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPOSITORY = 'https://github.com/google-deepmind/mujoco_menagerie.git'
export const MODEL_ID = 'unitree-go2-menagerie'
export const scriptDirectory = dirname(fileURLToPath(import.meta.url))
export const repositoryRoot = resolve(scriptDirectory, '..')
export const modelRoot = join(repositoryRoot, 'src-tauri', 'resources', 'simulation', 'models', MODEL_ID)
export const lockPath = join(modelRoot, 'menagerie.lock.json')

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}
export function sha256File(path) {
  return sha256Bytes(readFileSync(path))
}
export function posixRelative(root, path) {
  return relative(root, path).split(sep).join('/')
}
export function assertSafeRelative(path, label = 'resource path') {
  if (!path || path.includes('\\') || path.startsWith('/') || path.startsWith('//') || /^[A-Za-z]:/.test(path) || /^[a-z]+:/i.test(path)) {
    throw new Error(`GO2_UNSAFE_${label.toUpperCase().replaceAll(' ', '_')}`)
  }
  const parts = path.split('/')
  if (parts.some((part) => part === '..' || part === '.' || part === '')) throw new Error(`GO2_UNSAFE_${label.toUpperCase().replaceAll(' ', '_')}`)
}
export function walkFiles(root) {
  const result = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const metadata = lstatSync(path)
      if (metadata.isSymbolicLink()) throw new Error('GO2_SYMBOLIC_LINK_REJECTED')
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) result.push(path)
      else throw new Error('GO2_NON_REGULAR_FILE_REJECTED')
    }
  }
  visit(root)
  return result.sort()
}
export function xmlFileReferences(xml) {
  const references = []
  for (const match of xml.matchAll(/<(mesh|texture|include)\b[^>]*\bfile="([^"]+)"/g)) {
    references.push({ kind: match[1], file: match[2] })
  }
  return references
}
export function readLock() {
  if (!existsSync(lockPath)) throw new Error('GO2_LOCK_MISSING')
  return JSON.parse(readFileSync(lockPath, 'utf8'))
}
export function verifyFormalResources({ quiet = false } = {}) {
  const lock = readLock()
  if (lock.status !== 'ready' || lock.repository !== REPOSITORY || lock.modelId !== MODEL_ID) throw new Error('GO2_LOCK_INVALID')
  if (!/^[0-9a-f]{40}$/.test(lock.commit) || !/^[0-9a-f]{64}$/.test(lock.archiveSha256)) throw new Error('GO2_LOCK_HASH_INVALID')
  if (lock.archiveUrl !== `https://github.com/google-deepmind/mujoco_menagerie/archive/${lock.commit}.zip`) throw new Error('GO2_ARCHIVE_URL_INVALID')
  if (!Array.isArray(lock.files) || !Array.isArray(lock.requiredFiles)) throw new Error('GO2_LOCK_FILES_INVALID')
  const expected = new Map(lock.files.map((file) => [file.path, file]))
  const actual = walkFiles(modelRoot).map((path) => posixRelative(modelRoot, path))
  const expectedPaths = [...expected.keys(), 'menagerie.lock.json'].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expectedPaths)) throw new Error('GO2_RESOURCE_SET_MISMATCH')
  let totalBytes = statSync(lockPath).size
  for (const [relativePath, record] of expected) {
    assertSafeRelative(relativePath)
    const path = join(modelRoot, ...relativePath.split('/'))
    if (statSync(path).size !== record.size || sha256File(path) !== record.sha256) throw new Error(`GO2_RESOURCE_HASH_MISMATCH:${relativePath}`)
    totalBytes += record.size
  }
  for (const path of lock.requiredFiles) if (!expected.has(path)) throw new Error(`GO2_REQUIRED_FILE_UNRECORDED:${path}`)
  const license = readFileSync(join(modelRoot, 'upstream', 'LICENSE'), 'utf8')
  if (!license.includes('Copyright (c) 2016-2022 HangZhou YuShu TECHNOLOGY CO.,LTD.') || !license.includes('Redistribution and use in source and binary forms')) throw new Error('GO2_LICENSE_INVALID')
  const upstreamXml = readFileSync(join(modelRoot, 'upstream', 'go2.xml'), 'utf8')
  for (const reference of xmlFileReferences(upstreamXml)) {
    assertSafeRelative(reference.file, 'XML reference')
    const target = reference.kind === 'mesh' ? `upstream/assets/${reference.file}` : `upstream/${reference.file}`
    if (!expected.has(target)) throw new Error(`GO2_XML_REFERENCE_UNRECORDED:${target}`)
  }
  const wrapper = readFileSync(join(modelRoot, 'unitree-go2-scene.xml'), 'utf8')
  for (const reference of xmlFileReferences(wrapper)) {
    assertSafeRelative(reference.file, 'wrapper reference')
    if (reference.kind === 'include' && reference.file !== 'upstream/go2.xml') throw new Error('GO2_WRAPPER_INCLUDE_INVALID')
  }
  if (totalBytes > 32 * 1024 * 1024) throw new Error('GO2_FORMAL_RESOURCES_EXCEED_32_MIB')
  if (!quiet) console.log(`Go2 assets verified offline: commit=${lock.commit}, files=${actual.length}, bytes=${totalBytes}`)
  return { lock, files: actual.length, totalBytes }
}
