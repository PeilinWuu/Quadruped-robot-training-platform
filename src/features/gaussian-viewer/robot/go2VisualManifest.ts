import lock from './go2Visuals.lock.json'

export type Go2VisualMode = 'official-mesh' | 'primitive-debug'
export interface Go2VisualPart {
  id: string; meshAssetName: string; sourceObj: string; glbUrl: string; bodyName: string; geomName: string
  meshScale: [number, number, number]; geomPosition: [number, number, number]
  geomOrientation: [number, number, number, number]; material: string | null; rgba: [number, number, number, number]
  sourceSha256: string; glbSha256: string; byteSize: number
}
export interface Go2VisualManifest { schemaVersion: number; modelId: 'unitree-go2-menagerie'; menagerieCommit: string; parts: Go2VisualPart[] }

function trustedUrl(value: string): boolean {
  return /^\/robot-visuals\/unitree-go2\/generated\/[a-z0-9_]+\.glb$/.test(value)
    && !value.includes('..') && !/^(?:https?|file|data|blob):/i.test(value)
}

export const GO2_VISUAL_MANIFEST: Go2VisualManifest = {
  schemaVersion: lock.schemaVersion,
  modelId: lock.modelId as 'unitree-go2-menagerie',
  menagerieCommit: lock.menagerieCommit,
  parts: lock.parts.map((part) => {
    if (!trustedUrl(part.glbUrl)) throw new Error('GO2_VISUAL_URL_NOT_TRUSTED')
    return part as Go2VisualPart
  }),
}
export const GO2_VISUAL_URLS = [...new Set(GO2_VISUAL_MANIFEST.parts.map((part) => part.glbUrl))]
export function isTrustedGo2VisualUrl(url: string): boolean { return trustedUrl(url) && GO2_VISUAL_URLS.includes(url) }
