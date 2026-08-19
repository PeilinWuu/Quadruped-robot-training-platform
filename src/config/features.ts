export interface MockResearchChartsFeature {
  enabled: boolean
  metricsProducerEnabled: boolean
}

type FeatureEnvironment = Record<string, string | boolean | undefined>

export function resolveMockResearchChartsFeature(
  environment: FeatureEnvironment,
): MockResearchChartsFeature {
  const enabled = environment.VITE_ENABLE_MOCK_RESEARCH_CHARTS === '1'
    && environment.VITE_D6_WEBKIT_MEM_DISABLE_CHARTS !== '1'
  return {
    enabled,
    metricsProducerEnabled: enabled
      && environment.VITE_D6_WEBKIT_MEM_FREEZE_METRICS !== '1',
  }
}

// Mock research charts are excluded from both Dev and Production runtime unless
// a developer explicitly opts in with VITE_ENABLE_MOCK_RESEARCH_CHARTS=1.
export const MOCK_RESEARCH_CHARTS = resolveMockResearchChartsFeature(import.meta.env)

export function resolveNativeMujocoViewerPoc(
  environment: FeatureEnvironment,
  development: boolean,
): boolean {
  return development && environment.VITE_D6_NATIVE_MUJOCO_VIEWER_POC === '1'
}

// This flag only removes the dynamic PlayCanvas viewport in an explicit dev POC.
// The native sidecar window is independently gated by D6_NATIVE_MUJOCO_VIEWER_POC=1.
export const NATIVE_MUJOCO_VIEWER_POC = resolveNativeMujocoViewerPoc(
  import.meta.env,
  import.meta.env.DEV,
)
