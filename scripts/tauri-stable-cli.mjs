import { spawn } from 'node:child_process'
import {
  existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const LINUX_WEBKIT_CACHE_ENTRIES = Object.freeze([
  'WebKitCache',
  'CacheStorage',
  'hsts',
])

const APP_IDENTIFIER = 'com.peilinwu.quadrupedrobotresearch'
const PROJECT_RUNTIME_NAMES = new Set([
  'quadruped-robot-research',
  'quadruped-simulation-sidecar',
])

export function planTauriInvocation(platform, rawArgs) {
  const args = [...rawArgs]
  const stableLinuxDev = platform === 'linux' && args[0] === 'dev'
  if (stableLinuxDev && !args.includes('--no-watch')) {
    const separator = args.indexOf('--')
    args.splice(separator < 0 ? args.length : separator, 0, '--no-watch')
  }
  return { args, stableLinuxDev }
}

export function planTauriEnvironment(
  platform,
  rawArgs,
  { baseEnvironment, projectRoot, userHome },
) {
  const environment = { ...baseEnvironment }
  const linuxReleaseBuild = platform === 'linux'
    && rawArgs[0] === 'build'
    && !rawArgs.includes('--debug')
  if (!linuxReleaseBuild) return { environment, linuxReleaseBuild }

  const remapFlags = [
    `--remap-path-prefix=${resolve(userHome)}=/rust-build-home`,
    `--remap-path-prefix=${resolve(projectRoot)}=/workspace`,
  ]
  environment.RUSTFLAGS = [environment.RUSTFLAGS?.trim(), ...remapFlags]
    .filter(Boolean)
    .join(' ')
  return { environment, linuxReleaseBuild }
}

export function isProjectRuntimeProcess(processInfo, projectRoot) {
  const executable = basename(processInfo.argv[0] ?? '')
  if (!PROJECT_RUNTIME_NAMES.has(executable)) return false
  const normalizedRoot = resolve(projectRoot)
  if (processInfo.cwd && resolve(processInfo.cwd) === normalizedRoot) return true
  return processInfo.argv.some((argument) => {
    if (!argument) return false
    const normalized = resolve(argument)
    return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}${sep}`)
  })
}

export function findProjectRuntimeProcesses(projectRoot, procRoot = '/proc') {
  if (!existsSync(procRoot)) return []
  const matches = []
  for (const entry of readdirSync(procRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue
    const pid = Number(entry.name)
    if (pid === process.pid) continue
    try {
      const argv = readFileSync(join(procRoot, entry.name, 'cmdline'))
        .toString('utf8')
        .split('\0')
        .filter(Boolean)
      const cwd = readlinkSync(join(procRoot, entry.name, 'cwd'))
      if (isProjectRuntimeProcess({ argv, cwd }, projectRoot)) {
        matches.push({ pid, executable: basename(argv[0] ?? '') })
      }
    } catch {
      // A process may exit or become unreadable while /proc is being scanned.
    }
  }
  return matches
}

export function rotateLinuxWebKitState({ appDataDir, recoveryParent, tag }) {
  const present = LINUX_WEBKIT_CACHE_ENTRIES.filter((entry) =>
    existsSync(join(appDataDir, entry)))
  if (present.length === 0) return { moved: [], recoveryDir: null }
  const recoveryDir = join(recoveryParent, tag)
  mkdirSync(recoveryDir, { recursive: true })
  for (const entry of present) {
    renameSync(join(appDataDir, entry), join(recoveryDir, entry))
  }
  return { moved: present, recoveryDir }
}

function linuxAppDataDir() {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  return join(dataHome, APP_IDENTIFIER)
}

function recoveryParentFor(appDataDir) {
  return join(dirname(appDataDir), `.${APP_IDENTIFIER}-webkit-recovery`)
}

function timestampTag() {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`
}

function runTauriCli(projectRoot, args, environment) {
  const cli = join(projectRoot, 'node_modules', '@tauri-apps', 'cli', 'tauri.js')
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: projectRoot,
      env: environment,
      stdio: 'inherit',
    })
    child.once('error', rejectPromise)
    child.once('exit', (code, signal) => {
      if (signal) rejectPromise(new Error(`Tauri CLI terminated by ${signal}`))
      else resolvePromise(code ?? 1)
    })
  })
}

export async function main(rawArgs = process.argv.slice(2)) {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const invocation = planTauriInvocation(process.platform, rawArgs)
  const invocationEnvironment = planTauriEnvironment(process.platform, rawArgs, {
    baseEnvironment: process.env,
    projectRoot,
    userHome: homedir(),
  })
  if (invocation.stableLinuxDev) {
    const active = findProjectRuntimeProcesses(projectRoot)
    if (active.length > 0) {
      const summary = active.map(({ pid, executable }) => `${executable}(${pid})`).join(', ')
      throw new Error(`Refusing a parallel Linux Dev launch; project runtime still active: ${summary}`)
    }
    const appDataDir = linuxAppDataDir()
    const rotated = rotateLinuxWebKitState({
      appDataDir,
      recoveryParent: recoveryParentFor(appDataDir),
      tag: timestampTag(),
    })
    if (rotated.recoveryDir) {
      console.log(
        `Linux WebKit network state rotated (${rotated.moved.join(', ')}): ${relative(projectRoot, rotated.recoveryDir)}`,
      )
    } else {
      console.log('Linux WebKit network state is already clean.')
    }
    console.log('Linux stable Dev mode: Rust file watching disabled; restart after Rust changes.')
  }
  if (invocationEnvironment.linuxReleaseBuild) {
    console.log('Linux Release mode: Rust source paths remapped for portable artifacts.')
  }
  return runTauriCli(projectRoot, invocation.args, invocationEnvironment.environment)
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main().then((code) => {
    process.exitCode = code
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
