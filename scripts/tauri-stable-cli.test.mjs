import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  isProjectRuntimeProcess,
  LINUX_WEBKIT_CACHE_ENTRIES,
  planTauriEnvironment,
  planTauriInvocation,
  rotateLinuxWebKitState,
} from './tauri-stable-cli.mjs'

test('Linux dev adds no-watch before application arguments only once', () => {
  assert.deepEqual(planTauriInvocation('linux', ['dev']), {
    args: ['dev', '--no-watch'], stableLinuxDev: true,
  })
  assert.deepEqual(planTauriInvocation('linux', ['dev', '--', '--demo']), {
    args: ['dev', '--no-watch', '--', '--demo'], stableLinuxDev: true,
  })
  assert.deepEqual(planTauriInvocation('linux', ['dev', '--no-watch']), {
    args: ['dev', '--no-watch'], stableLinuxDev: true,
  })
  assert.deepEqual(planTauriInvocation('win32', ['dev']), {
    args: ['dev'], stableLinuxDev: false,
  })
  assert.deepEqual(planTauriInvocation('linux', ['build']), {
    args: ['build'], stableLinuxDev: false,
  })
})

test('Linux release remaps user and workspace paths without changing other environments', () => {
  const baseEnvironment = { PATH: '/usr/bin', RUSTFLAGS: '-C target-cpu=x86-64' }
  assert.deepEqual(planTauriEnvironment('linux', ['build'], {
    baseEnvironment,
    projectRoot: '/data/project',
    userHome: '/home/developer',
  }), {
    environment: {
      PATH: '/usr/bin',
      RUSTFLAGS: '-C target-cpu=x86-64 --remap-path-prefix=/home/developer=/rust-build-home --remap-path-prefix=/data/project=/workspace',
    },
    linuxReleaseBuild: true,
  })
  assert.deepEqual(planTauriEnvironment('linux', ['build', '--debug'], {
    baseEnvironment,
    projectRoot: '/data/project',
    userHome: '/home/developer',
  }), {
    environment: baseEnvironment,
    linuxReleaseBuild: false,
  })
  assert.deepEqual(planTauriEnvironment('win32', ['build'], {
    baseEnvironment,
    projectRoot: 'C:\\project',
    userHome: 'C:\\Users\\developer',
  }), {
    environment: baseEnvironment,
    linuxReleaseBuild: false,
  })
})

test('cache rotation moves only the three WebKit network-state entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tauri-stable-cli-'))
  const appDataDir = join(root, 'app-data')
  const recoveryParent = join(root, 'recovery')
  try {
    for (const entry of LINUX_WEBKIT_CACHE_ENTRIES) {
      const path = join(appDataDir, entry)
      if (entry === 'hsts') {
        await mkdir(appDataDir, { recursive: true })
        await writeFile(path, 'network-state')
      } else {
        await mkdir(path, { recursive: true })
        await writeFile(join(path, 'marker'), 'network-state')
      }
    }
    await mkdir(join(appDataDir, 'storage'), { recursive: true })
    await mkdir(join(appDataDir, 'scenes'), { recursive: true })
    await writeFile(join(appDataDir, 'storage', 'keep'), 'user-data')
    const result = rotateLinuxWebKitState({ appDataDir, recoveryParent, tag: 'test-run' })
    assert.deepEqual(result.moved, [...LINUX_WEBKIT_CACHE_ENTRIES])
    assert.equal(await readFile(join(appDataDir, 'storage', 'keep'), 'utf8'), 'user-data')
    await assert.doesNotReject(() => readFile(join(result.recoveryDir, 'hsts'), 'utf8'))
    for (const entry of ['WebKitCache', 'CacheStorage']) {
      assert.equal(
        await readFile(join(result.recoveryDir, entry, 'marker'), 'utf8'),
        'network-state',
      )
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('project runtime detection is exact and repository scoped', () => {
  const project = '/workspace/quadruped'
  assert.equal(isProjectRuntimeProcess({
    argv: ['/workspace/quadruped/src-tauri/target/debug/quadruped-robot-research'],
    cwd: project,
  }, project), true)
  assert.equal(isProjectRuntimeProcess({
    argv: ['/opt/app/quadruped-simulation-sidecar', '--resource-root', project],
    cwd: '/opt/app',
  }, project), true)
  assert.equal(isProjectRuntimeProcess({
    argv: ['/opt/app/quadruped-simulation-sidecar'],
    cwd: '/opt/app',
  }, project), false)
  assert.equal(isProjectRuntimeProcess({
    argv: ['/usr/bin/WebKitWebProcess'],
    cwd: project,
  }, project), false)
})
