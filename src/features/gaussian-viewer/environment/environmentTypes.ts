import type { EnvironmentId } from '../../../services/simulation/types'

export interface EnvironmentOverlayStatus {
  environmentId: EnvironmentId
  visible: boolean
  gridVisible: boolean
  entityCount: number
  materialCount: number
  halfExtent: number
  floorHeight: number
}

export interface EnvironmentBounds {
  center: [number, number, number]
  radius: number
}
