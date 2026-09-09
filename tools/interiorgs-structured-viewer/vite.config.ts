import { defineConfig } from 'vite'
import { createReadStream, statSync } from 'node:fs'
import { extname, join } from 'node:path'

const sceneRoot = 'D:/interiorgs_data/office_01'
const allowedFiles = new Set([
  '3dgs_compressed.ply', 'scene_yup.sog', 'labels.json', 'occupancy.json', 'occupancy.png',
  'structure.json', 'fire_roi.json', 'fire_preview/fire_manifest.json', 'fire_preview/fire_frames.bin',
])

const mime: Record<string, string> = {
  '.ply': 'application/octet-stream', '.sog': 'application/octet-stream',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png',
  '.bin': 'application/octet-stream',
}

export default defineConfig({
  root: __dirname,
  plugins: [{
    name: 'interiorgs-scene-assets',
    configureServer(server) {
      server.middlewares.use('/scene', (request, response, next) => {
        const filename = decodeURIComponent((request.url ?? '/').split('?')[0]).replace(/^\/+/, '')
        if (!allowedFiles.has(filename)) { next(); return }
        const path = join(sceneRoot, filename)
        try {
          response.statusCode = 200
          response.setHeader('Content-Type', mime[extname(path)] ?? 'application/octet-stream')
          response.setHeader('Content-Length', statSync(path).size)
          response.setHeader('Cache-Control', 'no-store')
          createReadStream(path).pipe(response)
        } catch {
          response.statusCode = 404
          response.end('Scene asset not found')
        }
      })
    },
  }],
  server: {
    host: '127.0.0.1',
    port: 8766,
    strictPort: true,
    fs: {
      allow: [
        __dirname,
        'C:/Users/Administrator/Documents/quadruped_robot_research/node_modules',
      ],
    },
  },
})
