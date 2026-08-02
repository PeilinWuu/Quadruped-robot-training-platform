export interface SceneOrientation {
  quaternion: [number, number, number, number]
}

export type Quaternion = SceneOrientation['quaternion']
export type OrientationAxis = 'x' | 'y' | 'z'

const MIN_QUATERNION_LENGTH_SQUARED = 1e-12

export function normalizeQuaternion(quaternion: Quaternion): Quaternion {
  if (!quaternion.every(Number.isFinite)) throw new Error('INVALID_ORIENTATION')
  const lengthSquared = quaternion.reduce((sum, value) => sum + value * value, 0)
  if (!Number.isFinite(lengthSquared) || lengthSquared < MIN_QUATERNION_LENGTH_SQUARED) {
    throw new Error('INVALID_ORIENTATION')
  }
  const inverseLength = 1 / Math.sqrt(lengthSquared)
  return quaternion.map((value) => value * inverseLength) as Quaternion
}

export function multiplyQuaternions(left: Quaternion, right: Quaternion): Quaternion {
  const [lx, ly, lz, lw] = left
  const [rx, ry, rz, rw] = right
  return normalizeQuaternion([
    lw * rx + lx * rw + ly * rz - lz * ry,
    lw * ry + ly * rw + lz * rx - lx * rz,
    lw * rz + lz * rw + lx * ry - ly * rx,
    lw * rw - lx * rx - ly * ry - lz * rz,
  ])
}

export function axisAngleQuaternion(axis: OrientationAxis, degrees: number): Quaternion {
  if (!Number.isFinite(degrees)) throw new Error('INVALID_ORIENTATION')
  const halfAngle = degrees * Math.PI / 360
  const sine = Math.sin(halfAngle)
  const cosine = Math.cos(halfAngle)
  if (axis === 'x') return normalizeQuaternion([sine, 0, 0, cosine])
  if (axis === 'y') return normalizeQuaternion([0, sine, 0, cosine])
  return normalizeQuaternion([0, 0, sine, cosine])
}

// World-axis increments are left-multiplied: next = delta * current.
export function rotateOrientation(
  orientation: SceneOrientation,
  axis: OrientationAxis,
  degrees: number,
): SceneOrientation {
  return {
    quaternion: multiplyQuaternions(
      axisAngleQuaternion(axis, degrees),
      normalizeQuaternion(orientation.quaternion),
    ),
  }
}

export interface SceneRecord {
  id: string
  displayName: string
  storedFilename: 'scene.sog'
  byteSize: number
  sha256: string
  importedAt: number
  sourceFormat: 'sog'
  orientation: SceneOrientation
  localUrl: string
}

export type ImportProgress = {
  phase: 'copying' | 'validating' | 'committing' | 'completed'
  bytesCopied: number
  totalBytes: number
}

export type ImportResult =
  | { status: 'cancelled' }
  | { status: 'imported'; scene: SceneRecord }

export interface ImportCallbacks {
  onOperationStart: (operationId: string) => void
  onProgress: (progress: ImportProgress) => void
  onOperationEnd: () => void
}

export interface SceneAdapter {
  readonly desktop: boolean
  listScenes(): Promise<SceneRecord[]>
  getCurrentScene(): Promise<SceneRecord | null>
  chooseAndImportScene(callbacks: ImportCallbacks): Promise<ImportResult>
  cancelImport(operationId: string): Promise<void>
  setCurrentScene(sceneId: string): Promise<SceneRecord>
  updateSceneOrientation(sceneId: string, quaternion: Quaternion): Promise<SceneRecord>
  deleteScene(sceneId: string): Promise<void>
}

export class SceneServiceError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'SceneServiceError'
    this.code = code
  }
}
