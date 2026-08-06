import { describe, expect, it } from 'vitest'
import { GO2_JOINT_NAMES, GO2_LEGS, mujocoPositionToPlayCanvas } from '../go2RigDefinition'
import { GO2_VISUAL_MANIFEST, GO2_VISUAL_URLS, isTrustedGo2VisualUrl } from '../go2VisualManifest'

describe('Go2 visual manifest', () => {
  it('uses the fixed model and all 16 allowlisted GLBs', () => {
    expect(GO2_VISUAL_MANIFEST.modelId).toBe('unitree-go2-menagerie')
    expect(GO2_VISUAL_MANIFEST.menagerieCommit).toBe('71f066ad0be9cd271f7ed58c030243ef157af9f4')
    expect(GO2_VISUAL_URLS).toHaveLength(16)
    expect(GO2_VISUAL_MANIFEST.parts).toHaveLength(33)
  })
  it('rejects remote and arbitrary URL schemes', () => {
    expect(isTrustedGo2VisualUrl('https://example.com/base_0.glb')).toBe(false)
    expect(isTrustedGo2VisualUrl('file:///base_0.glb')).toBe(false)
    expect(isTrustedGo2VisualUrl('data:model/gltf-binary,x')).toBe(false)
    expect(isTrustedGo2VisualUrl('blob:http://localhost/x')).toBe(false)
    expect(isTrustedGo2VisualUrl('/robot-visuals/unitree-go2/generated/unknown.glb')).toBe(false)
    expect(isTrustedGo2VisualUrl(GO2_VISUAL_URLS[0])).toBe(true)
  })
  it('maps every mesh to a known Go2 body and XML color', () => {
    const bodies = new Set(['base', ...GO2_LEGS.flatMap((leg) => [`${leg.name}_hip`, `${leg.name}_thigh`, `${leg.name}_calf`])])
    expect(GO2_VISUAL_MANIFEST.parts.every((part) => bodies.has(part.bodyName))).toBe(true)
    expect(GO2_VISUAL_MANIFEST.parts.every((part) => part.rgba.length === 4)).toBe(true)
    expect(new Set(GO2_VISUAL_MANIFEST.parts.map((part) => part.rgba.join(','))).size).toBe(4)
  })
  it('shares the exact 12-joint skeleton and Y-up basis', () => {
    expect(GO2_JOINT_NAMES).toHaveLength(12)
    expect(new Set(GO2_LEGS.flatMap((leg) => [...leg.joints])).size).toBe(12)
    expect(mujocoPositionToPlayCanvas([1, 2, 3])).toEqual([1, 3, -2])
  })
  it('records explicit right-side hip rotations and foot offsets', () => {
    expect(GO2_VISUAL_MANIFEST.parts.some((part) => part.bodyName === 'FR_hip' && part.geomOrientation[1] === 1)).toBe(true)
    expect(GO2_VISUAL_MANIFEST.parts.filter((part) => part.meshAssetName === 'foot').every((part) => part.geomPosition[2] === -.213)).toBe(true)
  })
})
