import { browserSimulationAdapter } from './browserSimulationAdapter'
import type { SimulationAdapter } from './types'

let adapterPromise: Promise<SimulationAdapter> | null = null

export function simulationDesktopSupported(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}
export function getSimulationAdapter(): Promise<SimulationAdapter> {
  if (!adapterPromise) {
    adapterPromise = simulationDesktopSupported()
      ? import('./tauriSimulationAdapter').then(({ tauriSimulationAdapter }) => tauriSimulationAdapter)
      : Promise.resolve(browserSimulationAdapter)
  }
  return adapterPromise
}
