import { Application, Asset } from 'playcanvas'
import { isTrustedGo2VisualUrl } from './go2VisualManifest'

interface CachedAsset { asset: Asset; bytes: number }
export class Go2VisualAssetCache {
  private readonly app: Application
  private readonly timeoutMs: number
  private readonly loaded = new Map<string, CachedAsset>()
  private readonly pending = new Map<string, Promise<CachedAsset>>()
  private disposed = false
  constructor(app: Application, timeoutMs = 15_000) { this.app = app; this.timeoutMs = timeoutMs }

  async load(url: string, expectedHash: string, expectedBytes: number): Promise<CachedAsset> {
    if (this.disposed || !isTrustedGo2VisualUrl(url)) throw new Error('GO2_VISUAL_URL_BLOCKED')
    const cached = this.loaded.get(url); if (cached) return cached
    const existing = this.pending.get(url); if (existing) return existing
    const promise = this.loadFresh(url, expectedHash, expectedBytes).finally(() => this.pending.delete(url))
    this.pending.set(url, promise); return promise
  }

  dispose(): void {
    if (this.disposed) return; this.disposed = true
    for (const { asset } of this.loaded.values()) { asset.unload(); this.app.assets.remove(asset) }
    this.loaded.clear(); this.pending.clear()
  }

  get size(): number { return this.loaded.size }
  private async loadFresh(url: string, expectedHash: string, expectedBytes: number): Promise<CachedAsset> {
    const controller = new AbortController(); const timeout = globalThis.setTimeout(() => controller.abort(), this.timeoutMs)
    let bytes: ArrayBuffer
    try {
      const response = await fetch(url, { signal: controller.signal, credentials: 'same-origin' })
      if (!response.ok) throw new Error('GO2_VISUAL_FETCH_FAILED')
      bytes = await response.arrayBuffer()
    } finally { globalThis.clearTimeout(timeout) }
    if (this.disposed || bytes.byteLength !== expectedBytes) throw new Error('GO2_VISUAL_SIZE_MISMATCH')
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((value) => value.toString(16).padStart(2, '0')).join('')
    if (digest !== expectedHash) throw new Error('GO2_VISUAL_HASH_MISMATCH')
    return new Promise<CachedAsset>((resolve, reject) => {
      const filename = url.slice(url.lastIndexOf('/') + 1)
      const asset = new Asset(filename, 'container', { url, filename, size: bytes.byteLength, contents: bytes })
      const fail = () => { asset.unload(); this.app.assets.remove(asset); reject(new Error('GO2_VISUAL_PARSE_FAILED')) }
      asset.once('error', fail)
      asset.once('load', () => {
        if (this.disposed) { fail(); return }
        const result = { asset, bytes: bytes.byteLength }; this.loaded.set(url, result); resolve(result)
      })
      this.app.assets.add(asset); this.app.assets.load(asset)
    })
  }
}
