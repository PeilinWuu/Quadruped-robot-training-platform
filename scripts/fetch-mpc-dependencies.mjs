import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { spawnSync } from 'node:child_process'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, '..')
const lockPath = join(repositoryRoot, 'native', 'mujoco-sidecar', 'mpc-dependencies.lock.json')
const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
const cacheRoot = join(repositoryRoot, '.cache', 'mpc-dependencies')
const maximumArchiveBytes = 16 * 1024 * 1024

if (!['win32', 'linux'].includes(process.platform) || process.arch !== 'x64') {
  throw new Error('D5V MPC dependencies require Windows or Linux x86_64')
}
if (lock.schemaVersion !== 1 || Object.keys(lock.dependencies).join(',') !== 'eigen,osqp,qdldl') {
  throw new Error('Unsupported MPC dependency lock metadata')
}

function sha256(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const input = createReadStream(path)
    input.on('error', reject)
    input.on('data', chunk => hash.update(chunk))
    input.on('end', () => resolveHash(hash.digest('hex')))
  })
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repositoryRoot, encoding: 'utf8', windowsHide: true, shell: false })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`)
  return result.stdout
}

function safeEntry(entry) {
  const normalized = entry.replaceAll('\\', '/')
  return normalized.length > 0 && !normalized.startsWith('/') && !/^[A-Za-z]:/.test(normalized) &&
    !normalized.split('/').includes('..') && !normalized.startsWith('//')
}

async function ensureArchive(name, metadata) {
  if (!/^[a-f0-9]{40}$/.test(metadata.commit) || !/^[a-f0-9]{64}$/.test(metadata.sha256) ||
      metadata.size <= 0 || metadata.size > maximumArchiveBytes || !metadata.url.startsWith('https://')) {
    throw new Error(`Invalid lock metadata for ${name}`)
  }
  const dependencyRoot = join(cacheRoot, name, metadata.version)
  const archivePath = join(dependencyRoot, metadata.archive)
  mkdirSync(dependencyRoot, { recursive: true })
  if (existsSync(archivePath)) {
    const digest = await sha256(archivePath)
    if (statSync(archivePath).size === metadata.size && digest === metadata.sha256) return archivePath
    rmSync(archivePath, { force: true })
    throw new Error(`Cached ${name} archive failed locked size or SHA-256 validation and was removed`)
  }
  const temporary = `${archivePath}.${process.pid}.tmp`
  rmSync(temporary, { force: true })
  console.log(`Downloading pinned ${name} ${metadata.version}: ${metadata.url}`)
  const response = await fetch(metadata.url, { redirect: 'follow', headers: { 'User-Agent': 'quadruped-robot-research-d5v-mpc1' } })
  if (!response.ok || !response.body) throw new Error(`${name} download failed with HTTP ${response.status}`)
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > maximumArchiveBytes || (declared !== 0 && declared !== metadata.size)) {
    throw new Error(`${name} download Content-Length does not match the lock`)
  }
  let received = 0
  const guarded = Readable.from((async function* () {
    for await (const chunk of Readable.fromWeb(response.body)) {
      received += chunk.length
      if (received > maximumArchiveBytes) throw new Error(`${name} archive exceeded the size limit`)
      yield chunk
    }
  })())
  try {
    await pipeline(guarded, createWriteStream(temporary, { flags: 'wx' }))
    const digest = await sha256(temporary)
    if (received !== metadata.size || digest !== metadata.sha256) {
      throw new Error(`${name} archive validation failed (size=${received}, sha256=${digest})`)
    }
    renameSync(temporary, archivePath)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
  return archivePath
}

async function ensureExtracted(name, metadata, archivePath) {
  const dependencyRoot = join(cacheRoot, name, metadata.version)
  const installRoot = join(dependencyRoot, 'source')
  const markerPath = join(installRoot, '.verified-sha256')
  const expectedRoot = metadata.sourceRoot === '.' ? installRoot : join(installRoot, metadata.sourceRoot)
  if (existsSync(markerPath) && readFileSync(markerPath, 'utf8').trim() === metadata.sha256 && existsSync(expectedRoot)) {
    return expectedRoot
  }
  const entries = run('tar', ['-tf', archivePath]).split(/\r?\n/).filter(Boolean)
  if (entries.length === 0 || entries.some(entry => !safeEntry(entry))) throw new Error(`${name} archive contains an unsafe path`)
  const temporary = join(dependencyRoot, `source-${process.pid}.tmp`)
  rmSync(temporary, { recursive: true, force: true })
  mkdirSync(temporary, { recursive: true })
  try {
    run('tar', ['-xf', archivePath, '-C', temporary])
    const extractedRoot = metadata.sourceRoot === '.' ? temporary : join(temporary, metadata.sourceRoot)
    const resolvedTemporary = resolve(temporary)
    const resolvedExtracted = resolve(extractedRoot)
    if ((resolvedExtracted !== resolvedTemporary && !resolvedExtracted.startsWith(resolvedTemporary + sep)) ||
        !existsSync(extractedRoot)) {
      throw new Error(`${name} archive is missing its locked source root`)
    }
    rmSync(installRoot, { recursive: true, force: true })
    renameSync(temporary, installRoot)
    await import('node:fs/promises').then(({ writeFile }) => writeFile(markerPath, `${metadata.sha256}\n`, { flag: 'wx' }))
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true })
  }
  return metadata.sourceRoot === '.' ? installRoot : join(installRoot, metadata.sourceRoot)
}

const roots = {}
for (const [name, metadata] of Object.entries(lock.dependencies)) {
  const archivePath = await ensureArchive(name, metadata)
  roots[name] = await ensureExtracted(name, metadata, archivePath)
  console.log(`${name} ${metadata.version} verified: sha256=${metadata.sha256}`)
}

if (!existsSync(join(roots.eigen, 'Eigen', 'Core')) || !existsSync(join(roots.osqp, 'include', 'public', 'osqp.h')) ||
    !existsSync(join(roots.qdldl, 'include', 'qdldl.h'))) {
  throw new Error('Verified MPC dependency sources are incomplete')
}

export { roots }
