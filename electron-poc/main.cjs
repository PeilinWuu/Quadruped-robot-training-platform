const { app, BrowserWindow, ipcMain } = require('electron')
const { writeFile } = require('node:fs/promises')
const path = require('node:path')

const rendererUrl = process.env.D6_CHROMIUM_POC_URL || 'http://127.0.0.1:5175/'
const mode = process.env.D6_CHROMIUM_POC_MODE === 'static' ? 'static' : 'dynamic'
const diagnosticsPath = process.env.D6_CHROMIUM_POC_DIAGNOSTICS
  || `/tmp/d6-chromium-poc-${mode}-diagnostics.json`
let diagnosticsTimer = null
let rendererGone = false
let consoleErrors = 0
app.setPath('userData', `/tmp/d6-chromium-poc-user-data-${mode}`)

function versions() {
  return Object.freeze({
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    node: process.versions.node,
    v8: process.versions.v8,
  })
}

async function writeDiagnostics(window) {
  if (window.isDestroyed()) return
  try {
    const renderer = await window.webContents.executeJavaScript(`(() => ({
      heap: performance.memory ? {
        used: performance.memory.usedJSHeapSize,
        total: performance.memory.totalJSHeapSize,
        limit: performance.memory.jsHeapSizeLimit,
      } : null,
      workload: window.__D6_CHROMIUM_POC__ ?? null,
      href: location.href,
    }))()`, true)
    await writeFile(diagnosticsPath, JSON.stringify({
      timestamp: Date.now(), pid: process.pid, rendererPid: window.webContents.getOSProcessId(),
      mode, versions: versions(), rendererGone, consoleErrors, renderer,
    }, null, 2))
  } catch (error) {
    await writeFile(diagnosticsPath, JSON.stringify({
      timestamp: Date.now(), pid: process.pid, mode, versions: versions(), rendererGone,
      consoleErrors, diagnosticError: String(error),
    }, null, 2))
  }
}

function createWindow() {
  const window = new BrowserWindow({
    width: 460, height: 960, minWidth: 420, minHeight: 720,
    title: 'D6 Chromium Runtime POC', backgroundColor: '#050e16',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      devTools: true,
    },
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    rendererGone = true
    console.error('D6_CHROMIUM_RENDERER_GONE', details)
  })
  window.webContents.on('console-message', (details) => {
    if (details.level === 'error') {
      consoleErrors += 1
      console.error('D6_CHROMIUM_RENDERER_CONSOLE_ERROR', details.message)
    }
  })
  void window.loadURL(`${rendererUrl}?d6ChromiumPoc=1&mode=${mode}`)
  window.webContents.once('did-finish-load', () => {
    console.log('D6_CHROMIUM_POC_READY', JSON.stringify({
      mainPid: process.pid, rendererPid: window.webContents.getOSProcessId(), mode,
      versions: versions(), diagnosticsPath,
    }))
    void writeDiagnostics(window)
    diagnosticsTimer = setInterval(() => void writeDiagnostics(window), 10_000)
  })
  window.on('closed', () => {
    if (diagnosticsTimer) clearInterval(diagnosticsTimer)
    diagnosticsTimer = null
  })
}

ipcMain.handle('d6-poc:versions', () => versions())
app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())
