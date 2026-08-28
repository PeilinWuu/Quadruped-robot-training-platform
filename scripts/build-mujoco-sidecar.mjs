import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, lstatSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, '..')
const sourceDirectory = join(repositoryRoot, 'native', 'mujoco-sidecar')
const isWindows = process.platform === 'win32'
const platformKey = `${isWindows ? 'windows' : process.platform}-${process.arch === 'x64' ? 'x86_64' : process.arch}`
if (!['windows-x86_64', 'linux-x86_64'].includes(platformKey)) {
  throw new Error(`Sidecar builds require Windows or Linux x86_64, received ${platformKey}`)
}
const nativeViewerPocBuild = !isWindows && process.env.D6_NATIVE_MUJOCO_VIEWER_POC === '1'
const buildDirectory = join(sourceDirectory, isWindows ? 'build' : nativeViewerPocBuild ? 'build-linux-native-viewer-poc' : 'build-linux')
const mujocoRoot = join(repositoryRoot, '.cache', 'mujoco', '3.11.0', platformKey, 'install')
const outputDirectory = join(repositoryRoot, 'src-tauri', 'resources', 'sidecar')
const developmentResourceRoot = join(repositoryRoot, 'src-tauri', 'target', 'debug')
const releaseResourceRoot = join(repositoryRoot, 'src-tauri', 'target', 'release')
const executableName = `quadruped-simulation-sidecar${isWindows ? '.exe' : ''}`
const builtExecutable = join(buildDirectory, ...(isWindows ? ['Release', executableName] : [executableName]))
const runtimeLibraries = isWindows
  ? [[join(mujocoRoot, 'bin', 'mujoco.dll'), 'mujoco.dll']]
  : [
      [join(mujocoRoot, 'lib', 'libmujoco.so.3.11.0'), 'libmujoco.so.3.11.0'],
      [join(mujocoRoot, 'lib', 'libmujoco.so'), 'libmujoco.so'],
    ]
const stalePlatformFiles = isWindows
  ? ['quadruped-simulation-sidecar', 'libmujoco.so', 'libmujoco.so.3.11.0']
  : ['quadruped-simulation-sidecar.exe', 'mujoco.dll']

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repositoryRoot, stdio: 'inherit', shell: false, windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`)
}
function runWithEnvironment(command, args, environment) {
  const result = spawnSync(command, args, { cwd: repositoryRoot, stdio: 'inherit', shell: false, windowsHide: true, env: environment })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`)
}
function copyAndVerify(source, target) {
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(source, target)
  if (!existsSync(target) || statSync(target).size !== statSync(source).size) {
    throw new Error(`Copied resource failed size verification: ${target}`)
  }
}
function copyDirectoryVerified(source, target) {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(target, entry.name)
    if (lstatSync(from).isSymbolicLink()) throw new Error(`Symlink resource rejected: ${entry.name}`)
    if (entry.isDirectory()) copyDirectoryVerified(from, to)
    else if (entry.isFile()) copyAndVerify(from, to)
    else throw new Error(`Non-regular resource rejected: ${entry.name}`)
  }
}
function copyRuntimeResources(root) {
  for (const name of stalePlatformFiles) rmSync(join(root, 'resources', 'sidecar', name), { force: true })
  const runtimeExecutable = join(root, 'resources', 'sidecar', executableName)
  copyAndVerify(builtExecutable, runtimeExecutable)
  if (!isWindows) chmodSync(runtimeExecutable, 0o755)
  for (const [source, name] of runtimeLibraries) copyAndVerify(source, join(root, 'resources', 'sidecar', name))
  copyAndVerify(join(repositoryRoot, 'src-tauri', 'resources', 'simulation', 'models', 'minimal-quadruped-v1.xml'), join(root, 'resources', 'simulation', 'models', 'minimal-quadruped-v1.xml'))
  copyAndVerify(join(repositoryRoot, 'src-tauri', 'resources', 'simulation', 'models', 'unitree-go2-flat-ground-v1.xml'), join(root, 'resources', 'simulation', 'models', 'unitree-go2-flat-ground-v1.xml'))
  copyDirectoryVerified(join(repositoryRoot, 'src-tauri', 'resources', 'simulation', 'models', 'unitree-go2-menagerie'), join(root, 'resources', 'simulation', 'models', 'unitree-go2-menagerie'))
  copyAndVerify(join(repositoryRoot, 'src-tauri', 'resources', 'licenses', 'MuJoCo-Apache-2.0.txt'), join(root, 'resources', 'licenses', 'MuJoCo-Apache-2.0.txt'))
}

run(process.execPath, [join(scriptDirectory, 'verify-go2-menagerie.mjs')])
if (!existsSync(join(mujocoRoot, '.verified-sha256'))) {
  throw new Error(`Verified MuJoCo cache is missing for ${platformKey}; run npm run setup:mujoco before building`)
}
const configureArgs = ['-S', sourceDirectory, '-B', buildDirectory,
  `-DMUJOCO_ROOT=${mujocoRoot}`,
  `-DD6_NATIVE_VIEWER_POC_BUILD=${nativeViewerPocBuild ? 'ON' : 'OFF'}`]
if (isWindows) configureArgs.push('-G', 'Visual Studio 17 2022', '-A', 'x64')
else configureArgs.push('-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release')
run('cmake', configureArgs)
run('cmake', ['--build', buildDirectory, ...(isWindows ? ['--config', 'Release'] : []), '--parallel'])
runWithEnvironment('ctest', ['--test-dir', buildDirectory, ...(isWindows ? ['-C', 'Release'] : []), '--output-on-failure'], {
  ...process.env,
  D6_NATIVE_MUJOCO_VIEWER_POC: '0',
})
if (!existsSync(builtExecutable) || statSync(builtExecutable).size === 0) throw new Error('Release sidecar executable was not produced')
const bundledExecutable = join(outputDirectory, executableName)
for (const name of stalePlatformFiles) rmSync(join(outputDirectory, name), { force: true })
copyAndVerify(builtExecutable, bundledExecutable)
if (!isWindows) chmodSync(bundledExecutable, 0o755)
for (const [source, name] of runtimeLibraries) copyAndVerify(source, join(outputDirectory, name))
copyRuntimeResources(developmentResourceRoot)
copyRuntimeResources(releaseResourceRoot)
console.log(`Sidecar ready for ${platformKey}: executable=${statSync(builtExecutable).size} bytes`)
