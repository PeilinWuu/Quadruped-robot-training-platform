import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, readdir, lstat, rename } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync, gunzipSync } from 'node:zlib'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const lockPath = resolve(repository, 'assets/collaboration.lock.json')
const routes = ['fire_playback/table_high', 'fire_playback_room/sofa_high', 'fire_playback_room/curtain_high', 'fire_playback_v2/table_high_test']
const filename = /^(metadata\.json|thermal\.json|thermal_[0-9]{3}\.bin|frames_[0-9]{3}\.bin|proxy(?:-smooth)?\.bin)$/
const allowed = path => path === 'scene_yup.sog' || routes.some(route => path.startsWith(route + '/') && filename.test(path.slice(route.length + 1)))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const readJson = async path => JSON.parse(await readFile(path, 'utf8'))
const destination = lock => resolve(repository, 'data/collaboration', lock.sha256, 'office_01')

async function verify(root, lock) {
  for (const entry of lock.files) {
    if (!allowed(entry.path)) throw new Error(`Unexpected asset path: ${entry.path}`)
    const file = resolve(root, entry.path)
    if (!(await lstat(file)).isFile() || (await lstat(file)).isSymbolicLink()) throw new Error(`Invalid asset: ${entry.path}`)
    const bytes = await readFile(file)
    if (bytes.length !== entry.bytes || sha(bytes) !== entry.sha256) throw new Error(`Asset hash mismatch: ${entry.path}`)
  }
}

async function configure(root) {
  const path = resolve(repository, '.env.local')
  let text = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
  for (const [key, value] of [['GS_SCENE_DATA_ROOT', root.replaceAll('\\', '/')], ['BUNDLE_FIRE_PLAYBACK', '1']]) {
    const line = `${key}=${JSON.stringify(value)}`
    const pattern = new RegExp(`^${key}=.*$`, 'm')
    text = pattern.test(text) ? text.replace(pattern, () => line) : text.trimEnd() + '\n' + line + '\n'
  }
  await writeFile(path, text)
  console.log(`Assets ready. Restart Vite/Tauri, then import this scene in the desktop scene library:\n${resolve(root, 'scene_yup.sog')}`)
}

async function main() {
  const [command, input, output] = process.argv.slice(2)
  if (command === 'pack') {
    if (!input || !output) throw new Error('Usage: npm run assets:pack -- <office_01 directory> <output.json.gz>')
    const source = resolve(input)
    const paths = ['scene_yup.sog']
    for (const route of routes) {
      const names = (await readdir(resolve(source, route))).filter(name => filename.test(name)).sort()
      if (!names.includes('metadata.json') || !names.some(name => name.startsWith('frames_'))) throw new Error(`Incomplete playback: ${route}`)
      if (route !== routes[3] && (!names.includes('thermal.json') || !names.some(name => name.startsWith('thermal_')))) throw new Error(`Missing thermal data: ${route}`)
      paths.push(...names.map(name => `${route}/${name}`))
    }
    const files = [], payload = []
    for (const path of paths) {
      const sourceFile = resolve(source, path)
      const info = await lstat(sourceFile)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Invalid source: ${path}`)
      const bytes = await readFile(sourceFile)
      files.push({ path, bytes: bytes.length, sha256: sha(bytes) })
      payload.push(bytes.toString('base64'))
    }
    const archive = gzipSync(JSON.stringify({ schema: 1, payload }), { level: 6 })
    await mkdir(dirname(resolve(output)), { recursive: true })
    await writeFile(resolve(output), archive)
    await mkdir(dirname(lockPath), { recursive: true })
    await writeFile(lockPath, JSON.stringify({ schema: 1, description: 'office_01 GS + V1/V2 fire playback + relative thermal; no solver sources or raw simulation', bytes: archive.length, sha256: sha(archive), files }, null, 2) + '\n')
    console.log(`Wrote ${resolve(output)} (${archive.length} bytes, ${files.length} files). Review and commit assets/collaboration.lock.json with this data version.`)
    return
  }
  const lock = await readJson(lockPath)
  if (lock.schema !== 1 || !/^[a-f0-9]{64}$/.test(lock.sha256) || !Array.isArray(lock.files) || lock.files.some(entry => !allowed(entry.path))) throw new Error('Invalid asset lock')
  const root = destination(lock)
  if (command === 'verify') { await verify(root, lock); console.log('All collaboration asset hashes match.'); return }
  if (command !== 'setup') throw new Error('Use assets:pack, assets:setup or assets:verify')
  try { await verify(root, lock); await configure(root); return } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (!input) throw new Error('First setup needs the shared bundle: npm run assets:setup -- <bundle.json.gz>')
  const archive = await readFile(resolve(input))
  if (archive.length !== lock.bytes || sha(archive) !== lock.sha256) throw new Error('Bundle hash mismatch. Obtain the bundle matching this Git revision; no assets were installed.')
  const decoded = JSON.parse(gunzipSync(archive, { maxOutputLength: 512 * 1024 * 1024 }).toString('utf8'))
  if (decoded.schema !== 1 || !Array.isArray(decoded.payload) || decoded.payload.length !== lock.files.length) throw new Error('Invalid bundle')
  const staging = `${root}.install-${process.pid}-${Date.now()}`
  await mkdir(staging, { recursive: true })
  for (const [index, entry] of lock.files.entries()) {
    const bytes = Buffer.from(decoded.payload[index], 'base64')
    if (bytes.length !== entry.bytes || sha(bytes) !== entry.sha256) throw new Error(`Bundle entry mismatch: ${entry.path}`)
    const file = resolve(staging, entry.path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, bytes, { flag: 'wx' })
  }
  await verify(staging, lock)
  await rename(staging, root)
  await configure(root)
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
