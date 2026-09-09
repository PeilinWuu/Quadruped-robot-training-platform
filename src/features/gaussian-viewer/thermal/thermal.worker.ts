import { renderThermal } from './thermalMath'
import type { ThermalInput } from './thermalMath'
self.onmessage = (event: MessageEvent<ThermalInput>) => {
  try { self.postMessage({ frame: renderThermal(event.data) }) }
  catch(error) { self.postMessage({ error: error instanceof Error ? error.message : 'THERMAL_RENDER_FAILED' }) }
}
