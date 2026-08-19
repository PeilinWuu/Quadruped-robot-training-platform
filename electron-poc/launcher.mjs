import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'

const directory = dirname(fileURLToPath(import.meta.url))
const root = resolve(directory, '..')
const mode = process.argv.includes('--static') ? 'static' : 'dynamic'
const port = await new Promise((resolvePromise, rejectPromise) => {
  const server = createServer()
  server.once('error', rejectPromise)
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (!address || typeof address === 'string') {
      server.close()
      rejectPromise(new Error('Could not allocate a local POC port'))
      return
    }
    server.close(() => resolvePromise(address.port))
  })
})
const environment = {
  ...process.env,
  VITE_D6_CHROMIUM_POC: '1',
  VITE_D6_CHROMIUM_POC_MODE: mode,
  VITE_D6_WEBKIT_MEM_DISABLE_CHARTS: '1',
  VITE_D6_WEBKIT_MEM_FREEZE_METRICS: '1',
  VITE_D6_WEBKIT_MEM_DISABLE_VIEWER: '1',
  D6_CHROMIUM_POC_MODE: mode,
  D6_CHROMIUM_POC_URL: `http://127.0.0.1:${port}/`,
}
const vite = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: root, env: environment, stdio: 'inherit',
})
let viteExit = null
vite.once('exit', (code, signal) => { viteExit = { code, signal } })
let electron = null
const stop = () => {
  electron?.kill('SIGTERM')
  vite.kill('SIGTERM')
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)

try {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (viteExit) throw new Error(`D6 Chromium POC Vite exited early: ${JSON.stringify(viteExit)}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`)
      if (response.ok) break
    } catch { /* Vite is still starting. */ }
    if (attempt === 99) throw new Error('D6 Chromium POC Vite server did not start')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
  electron = spawn(join(root, 'node_modules/.bin/electron'), [join(directory, 'main.cjs')], {
    cwd: root, env: environment, stdio: 'inherit',
  })
  const code = await new Promise((resolvePromise, rejectPromise) => {
    electron.once('error', rejectPromise)
    electron.once('exit', (exitCode, signal) => {
      if (signal && signal !== 'SIGTERM') rejectPromise(new Error(`Electron terminated by ${signal}`))
      else resolvePromise(exitCode ?? 0)
    })
  })
  process.exitCode = code
} finally {
  vite.kill('SIGTERM')
}
