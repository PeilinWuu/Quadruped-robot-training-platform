export interface GroundPlane { normal: [number, number, number]; offset: number; sceneKey: string; sampleCount: number }

const KEY_PREFIX = 'gs-ground-plane-v1:'

function normalizePlane(normal: [number, number, number], offset: number): GroundPlane | null {
  const length = Math.hypot(...normal)
  if (!Number.isFinite(length) || length < 1e-6 || !Number.isFinite(offset)) return null
  let n: [number, number, number] = [normal[0] / length, normal[1] / length, normal[2] / length]
  let d = offset / length
  // Keep the normal pointing upwards in PlayCanvas coordinates.
  if (n[1] < 0) { n = [-n[0], -n[1], -n[2]]; d = -d }
  return { normal: n, offset: d, sceneKey: '', sampleCount: 0 }
}

export function fitGroundPlane(points: Array<[number, number, number]>, sceneKey = ''): GroundPlane | null {
  if (points.length < 3) return null
  const a = points[0]; const b = points[1]; const c = points[2]
  const ux = b[0] - a[0]; const uy = b[1] - a[1]; const uz = b[2] - a[2]
  const vx = c[0] - a[0]; const vy = c[1] - a[1]; const vz = c[2] - a[2]
  const normal: [number, number, number] = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]
  const offset = -(normal[0] * a[0] + normal[1] * a[1] + normal[2] * a[2])
  const plane = normalizePlane(normal, offset)
  return plane ? { ...plane, sceneKey, sampleCount: points.length } : null
}

export function groundHeightAt(plane: GroundPlane, x: number, z: number): number | null {
  const [a, b, c] = plane.normal
  if (Math.abs(b) < 1e-6 || !Number.isFinite(x) || !Number.isFinite(z)) return null
  return -(a * x + c * z + plane.offset) / b
}

export function saveGroundPlane(plane: GroundPlane): void {
  if (typeof localStorage === 'undefined' || !plane.sceneKey) return
  localStorage.setItem(KEY_PREFIX + plane.sceneKey, JSON.stringify(plane))
}

export function loadGroundPlane(sceneKey: string): GroundPlane | null {
  if (typeof localStorage === 'undefined' || !sceneKey) return null
  try {
    const value = JSON.parse(localStorage.getItem(KEY_PREFIX + sceneKey) ?? 'null') as GroundPlane | null
    if (!value || !Array.isArray(value.normal) || value.normal.length !== 3) return null
    return normalizePlane(value.normal as [number, number, number], value.offset)
      ? { ...normalizePlane(value.normal as [number, number, number], value.offset)!, sceneKey, sampleCount: value.sampleCount ?? 0 }
      : null
  } catch { return null }
}
