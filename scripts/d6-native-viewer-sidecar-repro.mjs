import { appendFileSync, createWriteStream } from 'node:fs'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const root = new URL('../src-tauri/target/debug/', import.meta.url).pathname
const executable = `${root}resources/sidecar/quadruped-simulation-sidecar`
const stdoutPath = '/tmp/d6-native-viewer-sidecar-repro.stdout.ndjson'
const stderrPath = '/tmp/d6-native-viewer-sidecar-repro.stderr.log'
const child = spawn(executable, ['--resource-root', root], {
  env: { ...process.env, D6_NATIVE_MUJOCO_VIEWER_POC: '1', D6_NATIVE_MUJOCO_VIEWER_FPS: '60' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
const stdoutLog = createWriteStream(stdoutPath, { flags: 'w' })
const stderrLog = createWriteStream(stderrPath, { flags: 'w' })
child.stdout.pipe(stdoutLog)
child.stderr.pipe(stderrLog)

let requestSequence = 0
let motionSequence = 1
let emptyFrames = 0
const pending = new Map()
const lines = createInterface({ input: child.stdout })
lines.on('line', (line) => {
  if (line.length === 0) {
    emptyFrames += 1
    appendFileSync(stderrPath, `D6_REPRO_EMPTY_STDOUT_FRAME count=${emptyFrames}\n`)
    return
  }
  try {
    const message = JSON.parse(line)
    if (message.requestId && pending.has(message.requestId)) {
      pending.get(message.requestId)(message)
      pending.delete(message.requestId)
    }
  } catch (error) {
    appendFileSync(stderrPath, `D6_REPRO_INVALID_STDOUT ${String(error)} sample=${JSON.stringify(line.slice(0, 200))}\n`)
  }
})

const request = (type, payload = {}) => new Promise((resolve, reject) => {
  const requestId = `repro-${++requestSequence}`
  const timer = setTimeout(() => {
    pending.delete(requestId)
    reject(new Error(`${type} timed out`))
  }, 5000)
  pending.set(requestId, (message) => {
    clearTimeout(timer)
    if (message.type === 'error') reject(new Error(`${type}: ${message.payload?.code}`))
    else resolve(message)
  })
  child.stdin.write(`${JSON.stringify({ protocolVersion: 1, requestId, type, timestamp: Date.now(), payload })}\n`)
})

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const motion = (forwardVelocity, yawRate) => request('set_motion_command', {
  sequence: motionSequence++, mode: 'locomotion', forwardVelocity,
  lateralVelocity: 0, yawRate, bodyHeight: 0.3, validForMs: 300,
})
const drive = async (seconds, forwardVelocity, yawRate) => {
  const deadline = performance.now() + seconds * 1000
  while (performance.now() < deadline) {
    await motion(forwardVelocity, yawRate)
    await sleep(50)
  }
  await request('clear_motion_command')
  await sleep(2000)
}

let exitCode = null
child.on('exit', (code, signal) => { exitCode = { code, signal } })
try {
  await request('hello', { clientName: 'tauri-host', clientProtocolVersion: 1 })
  await request('load_model', { modelId: 'unitree-go2-menagerie', environmentId: 'flat-ground-v1' })
  await request('start')
  console.log(`D6_REPRO_STARTED pid=${child.pid}`)
  await drive(20, 0.15, 0)
  await drive(3, 0, 0.3)
  await drive(3, 0, -0.3)
  await drive(3, 0.15, 0.2)
  await drive(3, 0.15, -0.2)
  await sleep(20000)
  console.log(`D6_REPRO_COMPLETE empty_frames=${emptyFrames} child_exit=${JSON.stringify(exitCode)}`)
  if (!exitCode) await request('shutdown')
} catch (error) {
  console.error(`D6_REPRO_FAILED ${String(error)} empty_frames=${emptyFrames} child_exit=${JSON.stringify(exitCode)}`)
  process.exitCode = 1
} finally {
  if (!exitCode) child.kill('SIGTERM')
  await new Promise((resolve) => child.once('close', resolve))
  console.log(`D6_REPRO_EXIT stdout=${stdoutPath} stderr=${stderrPath}`)
}
