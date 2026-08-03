import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, lstatSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, '..')
const sourceDirectory = join(repositoryRoot, 'native', 'mujoco-sidecar')
const buildDirectory = join(sourceDirectory, 'build')
const mujocoRoot = join(repositoryRoot, '.cache', 'mujoco', '3.11.0', 'install')
const outputDirectory = join(repositoryRoot, 'src-tauri', 'resources', 'sidecar')
const developmentResourceRoot = join(repositoryRoot, 'src-tauri', 'target', 'debug')
const releaseResourceRoot = join(repositoryRoot, 'src-tauri', 'target', 'release')
const executableName = 'quadruped-simulation-sidecar.exe'
const dllName = 'mujoco.dll'
const builtExecutable = join(buildDirectory, 'Release', executableName)
const sourceDll = join(mujocoRoot, 'bin', dllName)

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repositoryRoot, stdio: 'inherit', shell: false, windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`)
}
function copyAndVerify(source, target) {
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(source, target)
  if (!existsSync(target) || statSync(target).size !== statSync(source).size) throw new Error(`Copied resource failed size verification: ${target}`)
}
function copyDirectoryVerified(source, target) {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name); const to = join(target, entry.name)
    if (lstatSync(from).isSymbolicLink()) throw new Error(`Symlink resource rejected: ${entry.name}`)
    if (entry.isDirectory()) copyDirectoryVerified(from, to)
    else if (entry.isFile()) copyAndVerify(from, to)
    else throw new Error(`Non-regular resource rejected: ${entry.name}`)
  }
}
function copyRuntimeResources(root) {
  copyAndVerify(builtExecutable, join(root, 'resources', 'sidecar', executableName))
  copyAndVerify(sourceDll, join(root, 'resources', 'sidecar', dllName))
  copyAndVerify(join(repositoryRoot, 'src-tauri', 'resources', 'simulation', 'models', 'minimal-quadruped-v1.xml'), join(root, 'resources', 'simulation', 'models', 'minimal-quadruped-v1.xml'))
  copyDirectoryVerified(join(repositoryRoot, 'src-tauri', 'resources', 'simulation', 'models', 'unitree-go2-menagerie'), join(root, 'resources', 'simulation', 'models', 'unitree-go2-menagerie'))
  copyAndVerify(join(repositoryRoot, 'src-tauri', 'resources', 'licenses', 'MuJoCo-Apache-2.0.txt'), join(root, 'resources', 'licenses', 'MuJoCo-Apache-2.0.txt'))
}

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('D4C sidecar builds require Windows x64')
run(process.execPath, [join(scriptDirectory, 'verify-go2-menagerie.mjs')])
if (!existsSync(join(mujocoRoot, '.verified-sha256'))) {
  console.log('Verified MuJoCo cache is missing; fetching pinned MuJoCo 3.11.0...')
  run(process.execPath, [join(scriptDirectory, 'fetch-mujoco.mjs')])
}
run('cmake', ['--version'])
run('cmake', ['-S', sourceDirectory, '-B', buildDirectory, '-G', 'Visual Studio 17 2022', '-A', 'x64', `-DMUJOCO_ROOT=${mujocoRoot}`])
run('cmake', ['--build', buildDirectory, '--config', 'Release', '--parallel'])
run('ctest', ['--test-dir', buildDirectory, '-C', 'Release', '--output-on-failure'])
if (!existsSync(builtExecutable) || statSync(builtExecutable).size === 0) throw new Error('Release sidecar executable was not produced')
copyAndVerify(builtExecutable, join(outputDirectory, executableName))
copyAndVerify(sourceDll, join(outputDirectory, dllName))
copyRuntimeResources(developmentResourceRoot)
copyRuntimeResources(releaseResourceRoot)
console.log(`D4C sidecar ready: exe=${statSync(builtExecutable).size} bytes, mujoco.dll=${statSync(sourceDll).size} bytes`)
