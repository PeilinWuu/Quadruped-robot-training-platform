import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, '..')
const sourceDirectory = join(repositoryRoot, 'native', 'mujoco-sidecar')
const buildDirectory = join(sourceDirectory, 'build')
const outputDirectory = join(repositoryRoot, 'src-tauri', 'resources', 'sidecar')
const developmentOutputDirectory = join(repositoryRoot, 'src-tauri', 'target', 'debug', 'resources', 'sidecar')
const releaseOutputDirectory = join(repositoryRoot, 'src-tauri', 'target', 'release', 'resources', 'sidecar')
const executableName = 'quadruped-simulation-sidecar.exe'
const builtExecutable = join(buildDirectory, 'Release', executableName)
const resourceExecutable = join(outputDirectory, executableName)

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`)
  }
}

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('D4B sidecar builds currently require Windows x64')
}

run('cmake', ['--version'])
run('cmake', [
  '-S', sourceDirectory,
  '-B', buildDirectory,
  '-G', 'Visual Studio 17 2022',
  '-A', 'x64',
])
run('cmake', ['--build', buildDirectory, '--config', 'Release', '--parallel'])
run('ctest', ['--test-dir', buildDirectory, '-C', 'Release', '--output-on-failure'])

if (!existsSync(builtExecutable) || statSync(builtExecutable).size === 0) {
  throw new Error('Release sidecar executable was not produced')
}

function copyAndVerify(target) {
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(builtExecutable, target)
  if (!existsSync(target) || statSync(target).size !== statSync(builtExecutable).size) {
    throw new Error(`Copied sidecar executable failed size verification: ${target}`)
  }
}

copyAndVerify(resourceExecutable)
copyAndVerify(join(developmentOutputDirectory, executableName))
copyAndVerify(join(releaseOutputDirectory, executableName))
console.log(`Sidecar resource ready: ${resourceExecutable} (${statSync(resourceExecutable).size} bytes)`)
