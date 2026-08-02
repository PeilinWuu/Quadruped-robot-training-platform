import { copyFile, mkdir, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const PRODUCTION_PUBLIC_ASSETS = ['favicon.svg', 'icons.svg'] as const

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
      const sogFiles = await findSogFiles(output)
      if (sogFiles.length > 0) {
        throw new Error('Production build contains forbidden SOG assets')
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

// Development keeps the local test fixture. Production copies only an explicit small-asset list.
export default defineConfig(({ command }) => ({
  publicDir: command === 'serve' ? 'public' : false,
  plugins: [react(), productionPublicAssets()],
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
