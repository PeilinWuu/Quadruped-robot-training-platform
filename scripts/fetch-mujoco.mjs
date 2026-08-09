import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, copyFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { spawnSync } from 'node:child_process'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, '..')
const lockPath = join(repositoryRoot, 'native', 'mujoco-sidecar', 'mujoco.lock.json')
const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
const platformKey = `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch === 'x64' ? 'x86_64' : process.arch}`
const asset = lock.assets?.[platformKey]
const cacheRoot = join(repositoryRoot, '.cache', 'mujoco', lock.version, platformKey)
const archivePath = asset ? join(cacheRoot, asset.archive) : ''
const installRoot = join(cacheRoot, 'install')
const markerPath = join(installRoot, '.verified-sha256')
const maximumArchiveBytes = 64 * 1024 * 1024

if (lock.schemaVersion !== 2 || lock.version !== '3.11.0' || lock.license !== 'Apache-2.0' || !asset) {
  throw new Error(`Unsupported MuJoCo platform or lock metadata: ${platformKey}`)
}
if (!asset.officialAssetUrl.startsWith(`https://github.com/google-deepmind/mujoco/releases/download/${lock.version}/`)) {
  throw new Error('MuJoCo asset URL is not the pinned official release')
}
if (!/^[a-f0-9]{64}$/.test(asset.sha256) || asset.assetSize <= 0 || asset.assetSize > maximumArchiveBytes) {
  throw new Error('MuJoCo locked asset metadata is invalid')
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
  const normalized = entry.replaceAll('\\', '/').replace(/^\.\//, '')
  return normalized.length > 0 && !normalized.startsWith('/') && !/^[A-Za-z]:/.test(normalized) &&
    !normalized.split('/').includes('..') && !normalized.startsWith('//')
}

async function verifiedArchive() {
  mkdirSync(cacheRoot, { recursive: true })
  if (existsSync(archivePath)) {
    const digest = await sha256(archivePath)
    if (statSync(archivePath).size === asset.assetSize && digest === asset.sha256) return
    rmSync(archivePath, { force: true })
    throw new Error('Cached MuJoCo archive failed locked size or SHA-256 validation and was removed')
  }
  const temporary = `${archivePath}.${process.pid}.tmp`
  rmSync(temporary, { force: true })
  console.log(`Downloading pinned MuJoCo ${lock.version} for ${platformKey}: ${asset.officialAssetUrl}`)
  const response = await fetch(asset.officialAssetUrl, { redirect: 'follow', headers: { 'User-Agent': 'quadruped-robot-research-d6-linux' } })
  if (!response.ok || !response.body) throw new Error(`MuJoCo download failed with HTTP ${response.status}`)
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > maximumArchiveBytes || (declared !== 0 && declared !== asset.assetSize)) {
    throw new Error('MuJoCo download Content-Length does not match the lock')
  }
  let received = 0
  const guarded = Readable.from((async function* () {
    for await (const chunk of Readable.fromWeb(response.body)) {
      received += chunk.length
      if (received > maximumArchiveBytes) throw new Error('MuJoCo archive exceeded the download size limit')
      yield chunk
    }
  })())
  try {
    await pipeline(guarded, createWriteStream(temporary, { flags: 'wx' }))
    const digest = await sha256(temporary)
    if (received !== asset.assetSize || digest !== asset.sha256) {
      throw new Error(`MuJoCo archive validation failed (size=${received}, sha256=${digest})`)
    }
    renameSync(temporary, archivePath)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

function selectedArchiveEntries(entries) {
  return entries.filter(entry => {
    const normalized = entry.replaceAll('\\', '/').replace(/^\.\//, '')
    const prefix = asset.sourceRoot === '.' ? '' : `${asset.sourceRoot}/`
    const relative = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized
    if (relative === 'LICENSE' || /^include\/mujoco\/[^/]+\.h$/.test(relative)) return true
    if (platformKey === 'windows-x86_64') return relative === 'bin/mujoco.dll' || relative === 'lib/mujoco.lib'
    return /^lib\/libmujoco\.so(?:\.3\.11(?:\.0)?)?$/.test(relative)
  })
}

async function extractRequired() {
  const runtimeFiles = platformKey === 'windows-x86_64'
    ? ['LICENSE', 'bin/mujoco.dll', 'lib/mujoco.lib', 'include/mujoco/mujoco.h']
    : ['LICENSE', 'lib/libmujoco.so', 'lib/libmujoco.so.3.11.0', 'include/mujoco/mujoco.h']
  const installedFiles = runtimeFiles.map(relative => join(installRoot, ...relative.split('/')))
  if (existsSync(markerPath) && readFileSync(markerPath, 'utf8').trim() === asset.sha256 &&
      installedFiles.every(path => existsSync(path) && statSync(path).size > 0)) return

  const entries = run('tar', ['-tf', archivePath]).split(/\r?\n/).filter(Boolean)
  if (entries.length === 0 || entries.some(entry => !safeEntry(entry))) throw new Error('MuJoCo archive contains an unsafe path')
  const selected = selectedArchiveEntries(entries)
  const prefix = asset.sourceRoot === '.' ? '' : `${asset.sourceRoot}/`
  const normalizedSelected = selected.map(entry => {
    const normalized = entry.replaceAll('\\', '/').replace(/^\.\//, '')
    return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized
  })
  if (runtimeFiles.some(required => !normalizedSelected.includes(required))) {
    throw new Error(`Pinned MuJoCo archive is missing required files for ${platformKey}`)
  }
  const temporary = join(cacheRoot, `install-${process.pid}.tmp`)
  rmSync(temporary, { recursive: true, force: true })
  mkdirSync(temporary, { recursive: true })
  try {
    run('tar', ['-xf', archivePath, '-C', temporary, ...selected])
    const extracted = asset.sourceRoot === '.' ? temporary : join(temporary, asset.sourceRoot)
    for (const relative of runtimeFiles) {
      const candidate = resolve(extracted, ...relative.split('/'))
      if (!candidate.startsWith(resolve(temporary) + sep) || !existsSync(candidate) || statSync(candidate).size === 0) {
        throw new Error(`Extracted MuJoCo file is invalid: ${relative}`)
      }
    }
    rmSync(installRoot, { recursive: true, force: true })
    renameSync(extracted, installRoot)
    const markerTemporary = `${markerPath}.tmp`
    await import('node:fs/promises').then(({ writeFile }) => writeFile(markerTemporary, `${asset.sha256}\n`, { flag: 'w' }))
    renameSync(markerTemporary, markerPath)
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true })
  }
}

await verifiedArchive()
await extractRequired()
const licenseTarget = join(repositoryRoot, 'src-tauri', 'resources', 'licenses', 'MuJoCo-Apache-2.0.txt')
mkdirSync(dirname(licenseTarget), { recursive: true })
copyFileSync(join(installRoot, 'LICENSE'), licenseTarget)
console.log(`MuJoCo ${lock.version} ${platformKey} verified: sha256=${asset.sha256}, cache=${installRoot}`)

export { installRoot, platformKey }
