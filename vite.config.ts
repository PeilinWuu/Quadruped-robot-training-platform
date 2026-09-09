import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, readdir } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const PRODUCTION_PUBLIC_ASSETS = ['favicon.svg', 'icons.svg'] as const
const PRODUCTION_ROBOT_MOTION_ASSETS = [
  'robot-motion/solo8_walk/metadata.json',
  'robot-motion/solo8_walk/frames.bin',
  'robot-motion/solo8_walk/source-clip.json',
  'robot-motion/solo8_walk/LICENSE.txt',
] as const
const PRODUCTION_GROUND_COLLISION_ASSETS = [
  'ground-collision/office_01/metadata.json',
  'ground-collision/office_01/floor_height.bin',
  'ground-collision/office_01/valid_mask.bin',
] as const
const GO2_LOCK_PATH = 'src/features/gaussian-viewer/robot/go2Visuals.lock.json'
const FIRE_PLAYBACK_ROOT = 'D:/interiorgs_data/office_01/fire_playback'

function developmentFirePlaybackAssets(prefix = '/fire-playback', root = FIRE_PLAYBACK_ROOT): Plugin {
  return {
    name: `development-fire-playback-assets-${prefix}`,
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(prefix, (request, response, next) => {
        const pathname = decodeURIComponent((request.url ?? '/').split('?')[0]).replace(/^\/+/, '')
        if (!/^[a-z0-9_-]+\/(?:metadata\.json|thermal\.json|thermal_[0-9]{3}\.bin|frames_[0-9]{3}\.bin|proxy(?:-smooth)?\.bin)$/.test(pathname)) {
          next(); return
        }
        const path = resolve(root, pathname)
        void lstat(path).then((info) => {
          if (!info.isFile() || info.isSymbolicLink()) throw new Error('unsafe fire asset')
          response.statusCode = 200
          response.setHeader('Content-Type', extname(path) === '.json'
            ? 'application/json; charset=utf-8' : 'application/octet-stream')
          response.setHeader('Content-Length', info.size)
          response.setHeader('Cache-Control', 'no-store')
          createReadStream(path).pipe(response)
        }).catch(() => {
          response.statusCode = 404
          response.end('Fire playback asset not found')
        })
      })
    },
  }
}

function productionPublicAssets(): Plugin {
  let root = ''
  let output = ''
  return {
    name: 'production-public-asset-allowlist',
    apply: 'build',
    configResolved(config) {
      root = config.root
      output = resolve(config.root, config.build.outDir)
    },
    async closeBundle() {
      await mkdir(output, { recursive: true })
      await Promise.all(PRODUCTION_PUBLIC_ASSETS.map((asset) => (
        copyFile(resolve(root, 'public', asset), resolve(output, asset))
      )))
      await Promise.all(PRODUCTION_ROBOT_MOTION_ASSETS.map(async (asset) => {
        const input = resolve(root, 'public', asset)
        const target = resolve(output, asset)
        const info = await lstat(input)
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe robot motion production asset')
        await mkdir(resolve(target, '..'), { recursive: true })
        await copyFile(input, target)
      }))
      await Promise.all(PRODUCTION_GROUND_COLLISION_ASSETS.map(async (asset) => {
        const input = resolve(root, 'public', asset)
        const target = resolve(output, asset)
        const info = await lstat(input)
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe ground collision production asset')
        await mkdir(resolve(target, '..'), { recursive: true })
        await copyFile(input, target)
      }))
      const lock = JSON.parse(await readFile(resolve(root, GO2_LOCK_PATH), 'utf8')) as {
        sources: Array<{ outputGlb: string; glbSha256: string }>
      }
      const target = resolve(output, 'robot-visuals/unitree-go2/generated')
      await mkdir(target, { recursive: true })
      for (const source of lock.sources) {
        if (!/^[a-z0-9_]+\.glb$/.test(source.outputGlb)) throw new Error('Invalid Go2 production asset name')
        const input = resolve(root, 'public/robot-visuals/unitree-go2/generated', source.outputGlb)
        const info = await lstat(input)
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe Go2 production asset')
        const bytes = await readFile(input)
        if (createHash('sha256').update(bytes).digest('hex') !== source.glbSha256) throw new Error('Go2 production asset hash mismatch')
        await copyFile(input, resolve(target, source.outputGlb))
      }
      const sogFiles = await findSogFiles(output)
      if (sogFiles.length > 0) {
        throw new Error('Production build contains forbidden SOG assets')
      }
      // Tauri builds embed these playback assets so installed apps work offline.
      if (process.env.TAURI_ENV_PLATFORM) {
        const scenarios = [
          ['fire-playback', 'table_high'],
          ['fire-playback-room', 'sofa_high'],
          ['fire-playback-room', 'curtain_high'],
          ['fire-playback-v2', 'table_high_test'],
        ] as const
        for (const [route, scenario] of scenarios) {
          const input = resolve('D:/interiorgs_data/office_01', route.replaceAll('-', '_'), scenario)
          const target = resolve(output, route, scenario)
          await mkdir(target, { recursive: true })
          if (route !== 'fire-playback-v2') {
            const thermal = JSON.parse(await readFile(resolve(input, 'thermal.json'), 'utf8')) as { frames: Array<{ file: string; sha256: string }> }
            for (const frame of thermal.frames) {
              if (!/^thermal_[0-9]{3}\.bin$/.test(frame.file)) throw new Error('Unsafe thermal asset name')
              const bytes = await readFile(resolve(input, frame.file))
              if (createHash('sha256').update(bytes).digest('hex') !== frame.sha256) throw new Error('Thermal asset hash mismatch')
            }
          }
          for (const name of await readdir(input)) {
            if (!/^(metadata\.json|thermal\.json|thermal_[0-9]{3}\.bin|frames_[0-9]{3}\.bin|proxy(?:-smooth)?\.bin)$/.test(name)) continue
            const info = await lstat(resolve(input, name))
            if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe fire production asset')
            await copyFile(resolve(input, name), resolve(target, name))
          }
        }
      }
    },
  }
}

async function findSogFiles(directory: string): Promise<string[]> {
  const matches: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) matches.push(...await findSogFiles(path))
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.sog')) matches.push(path)
  }
  return matches
}

// Development serves generated Go2 GLBs and the local SOG fixture. Production copies only locked GLBs.
export default defineConfig(({ command }) => ({
  publicDir: command === 'serve' ? 'public' : false,
  plugins: [react(), developmentFirePlaybackAssets(), developmentFirePlaybackAssets('/fire-playback-v2', 'D:/interiorgs_data/office_01/fire_playback_v2'), developmentFirePlaybackAssets('/fire-playback-room', 'D:/interiorgs_data/office_01/fire_playback_room'), productionPublicAssets()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:3001',
    },
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
}))
