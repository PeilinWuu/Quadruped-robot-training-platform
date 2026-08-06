import { verifyFormalResources } from './go2-menagerie-lib.mjs'

try {
  verifyFormalResources()
} catch (error) {
  console.error(`Go2 asset verification failed: ${error instanceof Error ? error.message : 'UNKNOWN'}`)
  process.exitCode = 1
}
