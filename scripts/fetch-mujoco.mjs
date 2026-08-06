import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, copyFileSync, cpSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { spawnSync } from 'node:child_process'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, '..')
const lockPath = join(repositoryRoot, 'native', 'mujoco-sidecar', 'mujoco.lock.json')
const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
const cacheRoot = join(repositoryRoot, '.cache', 'mujoco', lock.version)
const archivePath = join(cacheRoot, `mujoco-${lock.version}-windows-x86_64.zip`)
const installRoot = join(cacheRoot, 'install')
const markerPath = join(installRoot, '.verified-sha256')
const maximumArchiveBytes = 64 * 1024 * 1024

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('MuJoCo D4C requires Windows x64')
if (lock.version !== '3.11.0' || lock.platform !== 'windows' || lock.architecture !== 'x86_64') throw new Error('Unsupported MuJoCo lock metadata')
if (!lock.officialAssetUrl.startsWith('https://github.com/google-deepmind/mujoco/releases/download/3.11.0/')) throw new Error('MuJoCo asset URL is not the pinned official release')
if (!/^[a-f0-9]{64}$/.test(lock.sha256)) throw new Error('MuJoCo lock SHA-256 is invalid')
if (lock.assetSize <= 0 || lock.assetSize > maximumArchiveBytes) throw new Error('MuJoCo locked asset size is invalid')

function sha256(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const input = createReadStream(path)
    input.on('error', reject)
    input.on('data', chunk => hash.update(chunk))
    input.on('end', () => resolveHash(hash.digest('hex')))
  })
}

async function verifiedArchive() {
  mkdirSync(cacheRoot, { recursive: true })
  if (existsSync(archivePath)) {
    const size = statSync(archivePath).size
    const digest = await sha256(archivePath)
    if (size === lock.assetSize && digest === lock.sha256) return
    rmSync(archivePath, { force: true })
    throw new Error('Cached MuJoCo archive failed locked size or SHA-256 validation and was removed')
  }
  const temporary = `${archivePath}.${process.pid}.tmp`
  rmSync(temporary, { force: true })
  console.log(`Downloading pinned MuJoCo ${lock.version}: ${lock.officialAssetUrl}`)
  let response
  try {
    response = await fetch(lock.officialAssetUrl, { redirect: 'follow', headers: { 'User-Agent': 'quadruped-robot-research-d4c' } })
  } catch (error) {
    throw new Error(`MuJoCo download failed: ${error.message}`)
  }
  if (!response.ok || !response.body) throw new Error(`MuJoCo download failed with HTTP ${response.status}`)
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > maximumArchiveBytes || (declared !== 0 && declared !== lock.assetSize)) throw new Error('MuJoCo download Content-Length does not match the lock')
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
    if (received !== lock.assetSize || digest !== lock.sha256) throw new Error(`MuJoCo archive validation failed (size=${received}, sha256=${digest})`)
    renameSync(temporary, archivePath)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repositoryRoot, encoding: 'utf8', windowsHide: true, shell: false })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`)
  return result.stdout
}

function safeEntry(entry) {
  const normalized = entry.replaceAll('\\', '/')
  return normalized.length > 0 && !normalized.startsWith('/') && !/^[A-Za-z]:/.test(normalized) && !normalized.split('/').includes('..') && !normalized.startsWith('//')
}

async function extractRequired() {
  const installedFiles = ['LICENSE', 'bin/mujoco.dll', 'lib/mujoco.lib', 'include/mujoco/mujoco.h'].map(relative => join(installRoot, ...relative.split('/')))
  if (existsSync(markerPath) && readFileSync(markerPath, 'utf8').trim() === lock.sha256 && installedFiles.every(path => existsSync(path) && statSync(path).size > 0)) return
  rmSync(installRoot, { recursive: true, force: true })
  const entries = run('tar.exe', ['-tf', archivePath]).split(/\r?\n/).filter(Boolean)
  if (entries.some(entry => !safeEntry(entry))) throw new Error('MuJoCo ZIP contains an unsafe path')
  const selected = entries.filter(entry => {
    const relative = entry.replaceAll('\\', '/')
    return relative === 'LICENSE' || relative === 'bin/mujoco.dll' || relative === 'lib/mujoco.lib' || /^include\/mujoco\/[^/]+\.h$/.test(relative)
  })
  const required = ['LICENSE', 'bin/mujoco.dll', 'lib/mujoco.lib']
  if (required.some(item => !selected.includes(item)) || !selected.includes('include/mujoco/mujoco.h')) throw new Error('Pinned MuJoCo archive is missing required files')
  const temporary = join(cacheRoot, `install-${process.pid}.tmp`)
  rmSync(temporary, { recursive: true, force: true })
  mkdirSync(temporary, { recursive: true })
  try {
    run('tar.exe', ['-xf', archivePath, '-C', temporary, ...selected])
    const extracted = temporary
    for (const relative of ['LICENSE', 'bin/mujoco.dll', 'lib/mujoco.lib', 'include/mujoco/mujoco.h']) {
      const candidate = resolve(extracted, ...relative.split('/'))
      if (!candidate.startsWith(resolve(extracted) + sep) || !existsSync(candidate) || statSync(candidate).size === 0) throw new Error(`Extracted MuJoCo file is invalid: ${relative}`)
    }
    rmSync(installRoot, { recursive: true, force: true })
    cpSync(extracted, installRoot, { recursive: true, errorOnExist: true })
    mkdirSync(dirname(markerPath), { recursive: true })
    const markerTemporary = `${markerPath}.tmp`
    await import('node:fs/promises').then(({ writeFile }) => writeFile(markerTemporary, `${lock.sha256}\n`, { flag: 'w' }))
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
console.log(`MuJoCo ${lock.version} verified: sha256=${lock.sha256}, cache=${installRoot}`)

export { installRoot }
