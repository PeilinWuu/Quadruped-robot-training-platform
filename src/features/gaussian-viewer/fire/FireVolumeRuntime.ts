import { RoomFireAtmosphere } from './RoomFireAtmosphere'
import {
  ADDRESS_CLAMP_TO_EDGE,
  Application,
  BLEND_PREMULTIPLIED,
  CULLFACE_FRONT,
  Entity,
  FILTER_LINEAR,
  Layer,
  PIXELFORMAT_RG8,
  PIXELFORMAT_RGBA8,
  SEMANTIC_POSITION,
  ShaderMaterial,
  SORTMODE_MANUAL,
  Texture,
  Vec3,
} from 'playcanvas'
import { FIRE_VOLUME_V2_FRAGMENT } from './fireVolumeV2Shader'
import type { GaussianDepthCapture } from '../depth/GaussianDepthCapture'
import { GS_DEPTH_GLSL } from '../depth/gsDepthShader'
import { firePlaybackService, FirePlaybackService } from '../../../services/fire-playback/firePlaybackService'
import type {
  FirePlaybackMetadata,
  FirePlaybackSample,
} from '../../../services/fire-playback/types'

const VERTEX_SHADER = `
  attribute vec3 aPosition;
  uniform mat4 matrix_model;
  uniform mat4 matrix_viewProjection;
  varying vec3 vWorldPosition;
  void main(void) {
    vec4 world = matrix_model * vec4(aPosition, 1.0);
    vWorldPosition = world.xyz;
    gl_Position = matrix_viewProjection * world;
  }
`

// This is a bounded WebGL2 volume playback renderer. It deliberately uses the
// frozen legacy-clipped display profile and never runs or alters fire physics.
const FRAGMENT_SHADER = `
  precision highp float;
  ${GS_DEPTH_GLSL}
  varying vec3 vWorldPosition;
  uniform vec3 view_position;
  uniform vec3 uViewerLower;
  uniform vec3 uViewerUpper;
  uniform vec3 uSourceLower;
  uniform vec3 uSourceExtent;
  uniform sampler2D uVolume0;
  uniform sampler2D uVolume1;
  uniform vec3 uGridDimensions;
  uniform float uFrameAlpha;
  uniform float uFireStrength;
  uniform float uSmokeStrength;
  uniform float uDepthEnabled;
  uniform sampler2D uProxyDepth;
  uniform vec2 uViewport;
  uniform float uFarClip;
  uniform mat4 matrix_view;

  // Store the cropped XYZ volume as a 2D atlas with Z slices stacked down Y.
  // This avoids unreliable sampler3D/RG8 behavior in Windows WebView while
  // preserving filtered XY sampling and explicitly interpolating adjacent Z.
  vec2 sampleAtlas(sampler2D atlas, vec3 uv) {
    vec3 grid = max(uGridDimensions, vec3(1.0));
    vec3 voxel = clamp(uv, 0.0, 1.0) * max(grid - 1.0, vec3(0.0));
    float z0 = floor(voxel.z);
    float z1 = min(z0 + 1.0, grid.z - 1.0);
    float zBlend = voxel.z - z0;
    float atlasHeight = grid.y * grid.z;
    vec2 uv0 = vec2((voxel.x + 0.5) / grid.x,
                    (z0 * grid.y + voxel.y + 0.5) / atlasHeight);
    vec2 uv1 = vec2((voxel.x + 0.5) / grid.x,
                    (z1 * grid.y + voxel.y + 0.5) / atlasHeight);
    return mix(texture2D(atlas, uv0).rg, texture2D(atlas, uv1).rg, zBlend);
  }

  vec2 intersectBox(vec3 origin, vec3 direction) {
    vec3 safeDirection = direction;
    safeDirection.x = abs(direction.x) < 1.0e-6 ? 1.0e-6 : direction.x;
    safeDirection.y = abs(direction.y) < 1.0e-6 ? 1.0e-6 : direction.y;
    safeDirection.z = abs(direction.z) < 1.0e-6 ? 1.0e-6 : direction.z;
    vec3 inverseDirection = 1.0 / safeDirection;
    vec3 nearPlane = (uViewerLower - origin) * inverseDirection;
    vec3 farPlane = (uViewerUpper - origin) * inverseDirection;
    vec3 minimumPlane = min(nearPlane, farPlane);
    vec3 maximumPlane = max(nearPlane, farPlane);
    return vec2(max(max(minimumPlane.x, minimumPlane.y), minimumPlane.z),
                min(min(maximumPlane.x, maximumPlane.y), maximumPlane.z));
  }

  vec3 sourceUv(vec3 viewerPosition) {
    vec3 sourcePosition = vec3(viewerPosition.x, -viewerPosition.z, viewerPosition.y);
    return (sourcePosition - uSourceLower) / uSourceExtent;
  }

  // Exact closed-form FuelToTemperatureLUT used by FieryGS. The auxiliary
  // simulation temperature field is not the native renderer's color source.
  float fuelToTemperature(float fuel) {
    return max(0.0, 0.4 - (0.6 / (0.3 * 0.3)) * (fuel - 1.0) * (fuel - 0.4));
  }

  // Display-space approximation of the original black-body/CIE conversion at
  // scale_ratio=0.12. That range is red-orange-yellow, not white-hot plasma.
  vec3 fireColor(float temperature) {
    vec3 deep = vec3(0.78, 0.018, 0.002);
    vec3 orange = vec3(1.0, 0.16, 0.004);
    vec3 amber = vec3(1.0, 0.48, 0.018);
    vec3 yellow = vec3(1.0, 0.82, 0.16);
    vec3 warm = mix(deep, orange, smoothstep(0.35, 0.52, temperature));
    warm = mix(warm, amber, smoothstep(0.50, 0.76, temperature));
    return mix(warm, yellow, smoothstep(0.74, 1.0, temperature));
  }

  vec3 acesToneMap(vec3 value) {
    value *= 0.8;
    return clamp((value * (2.51 * value + 0.03)) /
                 (value * (2.43 * value + 0.59) + 0.14), 0.0, 1.0);
  }

  void main(void) {
    vec3 direction = normalize(vWorldPosition - view_position);
    vec2 hit = intersectBox(view_position, direction);
    float entry = max(hit.x, 0.0);
    float exitDistance = hit.y;
    if (uDepthEnabled > 0.5) {
      float depth = gsDepthMeters(texture2D(uProxyDepth, gl_FragCoord.xy / uViewport), uFarClip);
      float viewRayZ = -(matrix_view * vec4(direction, 0.0)).z;
      exitDistance = min(exitDistance, depth / max(viewRayZ, 1e-5) - 0.012);
    }
    if (exitDistance <= entry) discard;

    const int STEPS = 96;
    float distanceInside = exitDistance - entry;
    float stepLength = distanceInside / float(STEPS);
    vec3 position = view_position + direction * (entry + stepLength * 0.5);
    vec3 accumulatedFire = vec3(0.0);
    vec3 accumulatedSmoke = vec3(0.0);
    float transmittance = 1.0;

    for (int index = 0; index < STEPS; index++) {
      vec3 uv = sourceUv(position);
      if (all(greaterThanEqual(uv, vec3(0.0))) && all(lessThanEqual(uv, vec3(1.0)))) {
        vec2 state0 = sampleAtlas(uVolume0, uv);
        vec2 state1 = sampleAtlas(uVolume1, uv);
        vec2 state = mix(state0, state1, uFrameAlpha);
        float fuel = state.r;
        float temperature = fuelToTemperature(fuel);
        float occupied = smoothstep(0.001, 0.012, fuel);

        // FieryGS uses sigma_a=1 wherever fuel is positive. Exponential form
        // is the stable continuous equivalent of its (1 - sigma_a * dt).
        float sampleAlpha = 1.0 - exp(-occupied * stepLength);

        // The original black-body XYZ table has a large physical scale before
        // chromatic adaptation. This fixed normalization maps it into the same
        // display range while still honoring the frozen 0.005 strength.
        // 180 is the browser display normalization for the omitted physical
        // black-body XYZ magnitude. 55 made the native 0.005 profile nearly
        // invisible; the previous non-native density multiplier was far above
        // this range and produced the solid white plume.
        float emission = smoothstep(0.02, 0.40, temperature) * uFireStrength * 180.0;
        accumulatedFire += transmittance * fireColor(temperature) * emission * stepLength;

        // Native smoke exists only in the low-fuel interval (0.001, 0.6].
        float smokeGate = smoothstep(0.001, 0.035, fuel) *
                          (1.0 - smoothstep(0.56, 0.61, fuel));
        vec3 smokeColor = vec3(0.15, 0.14, 0.13);
        accumulatedSmoke += transmittance * smokeColor * sampleAlpha *
                            smokeGate * uSmokeStrength;

        transmittance *= 1.0 - sampleAlpha;
        if (transmittance < 0.015) break;
      }
      position += direction * stepLength;
    }
    float alpha = 1.0 - transmittance;
    if (alpha < 0.002) discard;

    // Legacy FieryGS path clips converted fire before smoke, then applies ACES.
    vec3 fireDisplay = clamp(accumulatedFire, 0.0, 1.0);
    vec3 displayColor = acesToneMap(fireDisplay + accumulatedSmoke);
    gl_FragColor = vec4(displayColor, alpha);
  }
`

export function sourceCOrderToWebGlTexture(
  source: Uint8Array,
  dimensions: readonly [number, number, number],
): Uint8Array {
  const [width, height, depth] = dimensions
  const expected = width * height * depth * 2
  if (source.byteLength !== expected) throw new Error('FIRE_FRAME_LENGTH_INVALID')
  const output = new Uint8Array(expected)
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) {
      for (let z = 0; z < depth; z += 1) {
        const sourceOffset = ((x * height + y) * depth + z) * 2
        const targetOffset = ((z * height + y) * width + x) * 2
        output[targetOffset] = source[sourceOffset]
        output[targetOffset + 1] = source[sourceOffset + 1]
      }
    }
  }
  return output
}

export class FireVolumeRuntime {
  private atmosphere: RoomFireAtmosphere | null = null
  private readonly service: FirePlaybackService
  private readonly ownsLayer: boolean
  private readonly companionVolumes = new Map<FirePlaybackService, FireVolumeRuntime>()
  private readonly app: Application
  private readonly camera: Entity
  private readonly layer: Layer
  private readonly entity: Entity
  private material: ShaderMaterial
  private smoke0: Texture | null = null
  private smoke1: Texture | null = null
  private readonly proxy: GaussianDepthCapture
  private statsSeconds = 0
  private statsFrames = 0
  private slowWindows = 0
  private contextLost = false
  private texture0: Texture | null = null
  private texture1: Texture | null = null
  private metadata: FirePlaybackMetadata | null = null
  private currentIndex = -1
  private nextIndex = -1
  private disposed = false
  private readonly removeSampleListener: () => void

  constructor(app: Application, camera: Entity, depth: GaussianDepthCapture, service = firePlaybackService, sharedLayer?: Layer) {
    this.proxy = depth
    this.service = service
    this.ownsLayer = !sharedLayer
    this.app = app
    this.camera = camera
    this.layer = sharedLayer ?? new Layer({ name: 'FieryGS Playback Volume Layer', transparentSortMode: SORTMODE_MANUAL })
    if (this.ownsLayer) {
      app.scene.layers.pushTransparent(this.layer)
      camera.camera!.layers = [...camera.camera!.layers, this.layer.id]
    }
    this.material = new ShaderMaterial({
      uniqueName: 'FieryGS-Playback-Volume-v1',
      attributes: { aPosition: SEMANTIC_POSITION },
      vertexGLSL: VERTEX_SHADER,
      fragmentGLSL: FRAGMENT_SHADER,
    })
    this.material.blendType = BLEND_PREMULTIPLIED
    this.material.cull = CULLFACE_FRONT
    // The back face is only a ray-exit proxy. Testing that proxy depth against
    // splat depth rejects the whole ray before volume integration can run.
    // The shader clips each ray at the shared scene depth instead.
    this.material.depthTest = false
    this.material.depthWrite = false
    this.material.update()
    this.entity = new Entity('FieryGS Playback Volume', app)
    this.entity.addComponent('render', { type: 'box', material: this.material })
    this.entity.render!.layers = [this.layer.id]
    for (const instance of this.entity.render!.meshInstances) instance.drawOrder = 1_000
    this.entity.enabled = false
    app.root.addChild(this.entity)
    this.removeSampleListener = this.service.onSample((sample, metadata) => {
      this.applySample(sample, metadata)
    })
  }

  update(deltaSeconds: number, advancePlayback = true): void {
    if (this.disposed) return
    for (const [service, volume] of this.companionVolumes) {
      if (![...this.service.getCompanions().values()].includes(service)) { volume.dispose(); this.companionVolumes.delete(service) }
    }
    for (const service of this.service.getCompanions().values()) {
      if (!this.companionVolumes.has(service)) this.companionVolumes.set(service, new FireVolumeRuntime(this.app, this.camera, this.proxy, service, this.layer))
    }
    if (advancePlayback) this.service.update(deltaSeconds)
    for (const volume of this.companionVolumes.values()) volume.update(deltaSeconds, false)
    if (this.companionVolumes.size) {
      // Disjoint scenario volumes share one transparent layer, sorted for the live camera.
      const origin = this.camera.getPosition(); const direction = this.camera.forward
      const volumes = [this, ...this.companionVolumes.values()]
      volumes.sort((a, b) => b.entity.getPosition().clone().sub(origin).dot(direction) - a.entity.getPosition().clone().sub(origin).dot(direction))
      volumes.forEach((volume, index) => { for (const mesh of volume.entity.render!.meshInstances) mesh.drawOrder = 1000 + index })
    }
    if (this.ownsLayer) {
      if (this.service.getState().sceneMode === 'room') {
        this.atmosphere ??= new RoomFireAtmosphere(this.app, this.camera, this.layer, this.proxy)
        this.atmosphere.update(this.service, this.contextLost)
      } else { this.atmosphere?.dispose(); this.atmosphere = null }
    }
    const service = this.service
    if (this.metadata?.schema.endsWith('v2') && Array.from(this.material.variants.values()).some((shader) => shader.failed)) {
      void service.fallback('FIRE_V2_SHADER_FAILED')
    }
    this.entity.enabled = !this.contextLost && service.quality !== 'off' && this.texture0 !== null && !['idle', 'loading', 'error'].includes(service.getState().phase)
    this.material.setParameter('uSteps', service.quality === 'high' ? 128 : service.quality === 'medium' ? 96 : 64)
    this.material.setParameter('uViewport', [this.app.graphicsDevice.width, this.app.graphicsDevice.height])
    this.material.setParameter('uFarClip', this.camera.camera!.farClip)
    const depth = this.proxy
    this.material.setParameter('uProxyDepth', depth.texture)
    this.material.setParameter('uDepthEnabled', service.depthOcclusion && depth.active ? 1 : 0)
    if (deltaSeconds > 0 && deltaSeconds < 1 && !document.hidden) {
      this.statsSeconds += deltaSeconds; this.statsFrames++
      if (this.statsSeconds >= 2) {
        service.fps = this.statsFrames / this.statsSeconds
        this.slowWindows = service.fps < 28 ? this.slowWindows + 1 : 0
        if (service.autoQuality && this.entity.enabled && this.slowWindows >= 2) {
          if (service.quality === 'high') service.setQuality('medium')
          else if (service.quality === 'medium') service.setQuality('low')
          else if (service.quality === 'low' && this.metadata?.schema.endsWith('v2')) void service.fallback('FIRE_LOW_FPS')
          this.slowWindows = 0
        }
        this.statsFrames = 0; this.statsSeconds = 0
      }
    }
  }

  syncDepth(): void {
    for (const volume of this.companionVolumes.values()) volume.syncDepth()
    this.service.depthStatus = this.proxy.status
    this.material.setParameter('uProxyDepth', this.proxy.texture)
    this.material.setParameter('uDepthEnabled', this.service.depthOcclusion && this.proxy.active ? 1 : 0)
    this.material.setParameter('uNearClip', this.camera.camera!.nearClip)
    this.material.setParameter('uFarClip', this.camera.camera!.farClip)
    this.material.setParameter('uViewport', [this.app.graphicsDevice.width, this.app.graphicsDevice.height])
    this.atmosphere?.update(this.service, this.contextLost)
  }

  setContextLost(lost: boolean): void {
    for (const volume of this.companionVolumes.values()) volume.setContextLost(lost)
    this.contextLost = lost
    if (!this.disposed) this.entity.enabled = !lost && this.texture0 !== null && this.texture1 !== null
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const volume of this.companionVolumes.values()) volume.dispose()
    this.companionVolumes.clear()
    this.atmosphere?.dispose(); this.atmosphere = null
    this.removeSampleListener()
    this.texture0?.destroy(); this.texture1?.destroy()
    this.texture0 = null; this.texture1 = null
    this.smoke0?.destroy(); this.smoke1?.destroy()
    this.entity.destroy()
    this.material.destroy()
    if (this.ownsLayer) {
      this.app.scene.layers.removeTransparent(this.layer)
      this.camera.camera!.layers = this.camera.camera!.layers.filter((id) => id !== this.layer.id)
    }
  }

  private applySample(sample: FirePlaybackSample, metadata: FirePlaybackMetadata): void {
    if (this.disposed) return
    if (this.metadata !== metadata) this.configure(metadata)
    if (sample.current.index === this.nextIndex && sample.current.index !== this.currentIndex) {
      ;[this.texture0, this.texture1] = [this.texture1, this.texture0]
      ;[this.smoke0, this.smoke1] = [this.smoke1, this.smoke0]
      ;[this.currentIndex, this.nextIndex] = [this.nextIndex, this.currentIndex]
      this.material.setParameter('uVolume0', this.texture0!)
      this.material.setParameter('uVolume1', this.texture1!)
      if (this.smoke0 && this.smoke1) {
        this.material.setParameter('uSmoke0', this.smoke0)
        this.material.setParameter('uSmoke1', this.smoke1)
      }
    }
    if (sample.current.index !== this.currentIndex) {
      this.uploadFrame(this.texture0, this.smoke0, sample.current.voxels, metadata)
      this.currentIndex = sample.current.index
    }
    if (sample.next.index !== this.nextIndex) {
      this.uploadFrame(this.texture1, this.smoke1, sample.next.voxels, metadata)
      this.nextIndex = sample.next.index
    }
    this.material.setParameter('uFrameAlpha', sample.alpha)
    this.entity.enabled = !this.contextLost && this.service.quality !== 'off'
    this.app.renderNextFrame = true
  }

  private configure(metadata: FirePlaybackMetadata): void {
    this.texture0?.destroy(); this.texture1?.destroy()
    this.smoke0?.destroy(); this.smoke1?.destroy()
    this.smoke0 = null; this.smoke1 = null
    const v2 = metadata.schema.endsWith('v2')
    const previous = this.material
    this.material = new ShaderMaterial({ uniqueName: v2 ? 'FieryGS-Playback-Volume-v2' : 'FieryGS-Playback-Volume-v1',
      attributes: { aPosition: SEMANTIC_POSITION }, vertexGLSL: VERTEX_SHADER,
      fragmentGLSL: v2 ? FIRE_VOLUME_V2_FRAGMENT : FRAGMENT_SHADER })
    this.material.blendType = BLEND_PREMULTIPLIED
    this.material.cull = CULLFACE_FRONT
    this.material.depthTest = false; this.material.depthWrite = false
    this.material.update()
    for (const instance of this.entity.render!.meshInstances) instance.material = this.material
    previous.destroy()
    this.metadata = metadata
    this.currentIndex = -1; this.nextIndex = -1
    this.texture0 = this.createTexture(metadata, 'FieryGS frame A')
    this.texture1 = this.createTexture(metadata, 'FieryGS frame B')
    if (v2) {
      this.smoke0 = this.createTexture(metadata, 'FieryGS smoke A')
      this.smoke1 = this.createTexture(metadata, 'FieryGS smoke B')
      this.material.setParameter('uSmoke0', this.smoke0)
      this.material.setParameter('uSmoke1', this.smoke1)
      this.material.setParameter('uEmissionScale', metadata.encoding.emissionScale!)
      this.material.setParameter('uSteps', 96)
    }
    this.material.setParameter('uDepthEnabled', 0)
    this.material.setParameter('uProxyDepth', this.proxy.texture)
    const sourceLower = new Vec3(...metadata.grid.worldLower)
    const sourceUpper = new Vec3(...metadata.grid.worldUpper)
    const viewerLower = new Vec3(sourceLower.x, sourceLower.z, -sourceUpper.y)
    const viewerUpper = new Vec3(sourceUpper.x, sourceUpper.z, -sourceLower.y)
    const center = viewerLower.clone().add(viewerUpper).mulScalar(.5)
    const extent = viewerUpper.clone().sub(viewerLower)
    this.entity.setLocalPosition(center)
    this.entity.setLocalScale(extent)
    this.material.setParameter('uVolume0', this.texture0)
    this.material.setParameter('uVolume1', this.texture1)
    this.material.setParameter('uViewerLower', viewerLower.toArray())
    this.material.setParameter('uViewerUpper', viewerUpper.toArray())
    this.material.setParameter('uSourceLower', sourceLower.toArray())
    this.material.setParameter('uSourceExtent', sourceUpper.clone().sub(sourceLower).toArray())
    this.material.setParameter('uGridDimensions', metadata.grid.dimensions)
    this.material.setParameter('uFireStrength', metadata.rendererProfile.strength)
    this.material.setParameter('uSmokeStrength', metadata.rendererProfile.smokeStrength)
    this.material.setParameter('uFrameAlpha', 0)
  }

  private createTexture(metadata: FirePlaybackMetadata, name: string): Texture {
    const [width, height, depth] = metadata.grid.dimensions
    if (width > this.app.graphicsDevice.maxTextureSize || height * depth > this.app.graphicsDevice.maxTextureSize) throw new Error('FIRE_ATLAS_TOO_LARGE')
    return new Texture(this.app.graphicsDevice, {
      name, width, height: height * depth, format: metadata.schema.endsWith('v2') ? PIXELFORMAT_RGBA8 : PIXELFORMAT_RG8,
      mipmaps: false, minFilter: FILTER_LINEAR, magFilter: FILTER_LINEAR,
      addressU: ADDRESS_CLAMP_TO_EDGE, addressV: ADDRESS_CLAMP_TO_EDGE,
    })
  }

  private uploadFrame(texture: Texture | null, smoke: Texture | null, source: Uint8Array, metadata: FirePlaybackMetadata): void {
    if (!metadata.schema.endsWith('v2')) { this.upload(texture, source, metadata.grid.dimensions); return }
    if (source.byteLength !== metadata.encoding.frameBytes) throw new Error('FIRE_FRAME_LENGTH_INVALID')
    const [w, h, d] = metadata.grid.dimensions
    const a = texture!.lock() as Uint8Array
    const b = smoke!.lock() as Uint8Array
    for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) for (let z = 0; z < d; z++) {
      const input = ((x * h + y) * d + z) * 8
      const output = ((z * h + y) * w + x) * 4
      for (let c = 0; c < 4; c++) { a[output+c] = source[input+c]; b[output+c] = source[input+4+c] }
    }
    texture!.unlock(); smoke!.unlock()
  }

  private upload(texture: Texture | null, source: Uint8Array, dimensions: [number, number, number]): void {
    if (!texture) return
    const upload = sourceCOrderToWebGlTexture(source, dimensions)
    const target = texture.lock()
    if (!(target instanceof Uint8Array) || target.byteLength !== upload.byteLength) {
      texture.unlock()
      throw new Error('FIRE_TEXTURE_LAYOUT_INVALID')
    }
    target.set(upload)
    texture.unlock()
  }
}
