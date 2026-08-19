import { RobotTelemetryBuffer } from '../services/simulation/RobotTelemetryBuffer'
import {
  FLAT_GROUND_ENVIRONMENT,
  type ModelMetadata,
  type RobotPose,
  type RobotTelemetry,
} from '../services/simulation/types'
import { useAppStore } from '../store/useAppStore'

export const D6_CHROMIUM_SOURCE_HZ = 50
export const D6_CHROMIUM_POSE_SOURCE_HZ = 60
export const D6_CHROMIUM_FRONTEND_INTERVAL_MS = 100

const JOINT_NAMES = [
  'FL_hip_joint', 'FL_thigh_joint', 'FL_calf_joint',
  'FR_hip_joint', 'FR_thigh_joint', 'FR_calf_joint',
  'RL_hip_joint', 'RL_thigh_joint', 'RL_calf_joint',
  'RR_hip_joint', 'RR_thigh_joint', 'RR_calf_joint',
] as const

const MODEL: ModelMetadata = {
  modelId: 'unitree-go2-menagerie', environmentId: 'flat-ground-v1',
  environment: FLAT_GROUND_ENVIRONMENT, timestep: 0.002,
  jointCount: 12, actuatorCount: 12, bodyCount: 49,
}

export interface D6ChromiumWorkloadCounters {
  mode: 'dynamic' | 'static'
  sourceTelemetry: number
  sourcePose: number
  storeTelemetryUpdates: number
  storePoseUpdates: number
  robotPanelRenders: number
  activeTimers: number
  startedAt: number
}

declare global {
  interface Window {
    __D6_CHROMIUM_POC__?: D6ChromiumWorkloadCounters
  }
}

function wave(sequence: number, phase = 0): number {
  return Math.sin(sequence * 0.037 + phase)
}

export function createD6Telemetry(sequence: number): RobotTelemetry {
  const time = sequence / D6_CHROMIUM_SOURCE_HZ
  const rootX = 0.15 * Math.sin(time * 0.2)
  const rootZ = 0.08 * Math.cos(time * 0.2)
  const linearSpeed = Math.abs(0.03 * Math.cos(time * 0.2))
  const phase = (time * 2.2) % 1
  const contacts = [phase < 0.65, phase >= 0.5, phase >= 0.5, phase < 0.65] as [boolean, boolean, boolean, boolean]
  const groundForce = (index: number): [number, number, number] => [
    wave(sequence, index) * 1.5, 0, contacts[index] ? 36 + wave(sequence, index + 1) * 3 : 0,
  ]
  return {
    sequence, simulationTime: time, wallTime: 1_780_000_000_000 + sequence * 20,
    modelId: 'unitree-go2-menagerie',
    source: { kind: 'mujoco-simulation', connectedToPhysicalRobot: false },
    root: {
      position: [rootX, 0.3 + wave(sequence) * 0.002, rootZ], orientation: [0, 0, 0, 1],
      linearVelocityWorld: [linearSpeed, 0, wave(sequence, 1) * 0.002],
      angularVelocityWorld: [0, wave(sequence, 2) * 0.01, 0],
      linearSpeed, angularSpeed: Math.abs(wave(sequence, 2) * 0.01),
    },
    imu: {
      orientation: [0, 0, 0, 1], angularVelocityBody: [0, wave(sequence, 2) * 0.01, 0],
      linearAccelerationBody: [wave(sequence, 3) * 0.02, 9.81, wave(sequence, 4) * 0.02],
      frame: 'body', includesGravity: true, source: 'root-body-state',
    },
    joints: JOINT_NAMES.map((name, index) => ({
      name, position: wave(sequence, index * 0.4) * 0.45,
      velocity: wave(sequence, index * 0.4 + 1) * 0.8,
      actuatorTorque: wave(sequence, index * 0.2) * 3,
      actuatorForce: wave(sequence, index * 0.2 + 0.5) * 3,
      controlTarget: wave(sequence, index * 0.4 + 0.1) * 0.45,
      lowerLimit: -1.5, upperLimit: 1.5, limited: true,
    })),
    feet: (['FL', 'FR', 'RL', 'RR'] as const).map((name, index) => ({
      name, inContact: contacts[index], contactCount: contacts[index] ? 1 : 0,
      normalForce: groundForce(index)[2], forceWorld: groundForce(index),
      positionWorld: [rootX + (index < 2 ? 0.25 : -0.25), 0, rootZ + (index % 2 ? -0.15 : 0.15)],
    })),
    collision: {
      environmentId: 'flat-ground-v1', totalEnvironmentContacts: contacts.filter(Boolean).length,
      footContacts: contacts.filter(Boolean).length, nonFootContacts: 0, torsoContacts: 0,
      headContacts: 0, limbContacts: 0, maxNormalForce: 39, totalNormalForce: 144,
      strongestContact: { category: 'feet', bodyName: 'FL_calf', geomName: 'FL', normalForce: 39, positionWorld: [0.25, 0, 0.15] },
      isFallen: false, fallReason: 'none', isOutOfBounds: false,
      rootHeightAboveFloor: 0.3, roll: 0, pitch: 0,
    },
    command: {
      sequence, mode: 'stand', forwardVelocity: 0, lateralVelocity: 0, yawRate: 0,
      bodyHeight: 0.3, validForMs: 300, ageMs: 0, timedOut: false,
      appliedByController: true, bodyHeightApplied: true,
      controllerAvailability: 'go2-convex-mpc-v1',
    },
    locomotion: {
      controllerId: 'go2-convex-mpc-v1', availability: 'available', state: 'standing',
      commandedForwardVelocity: 0, filteredForwardVelocity: 0, measuredForwardVelocity: linearSpeed,
      commandedYawRate: 0, filteredYawRate: 0, measuredYawRate: wave(sequence, 2) * 0.01,
      mpcFrequencyHz: 50, legControllerFrequencyHz: 250, horizonSteps: 10,
      gaitFrequencyHz: 2.2, dutyFactor: 0.65, gaitPhase: phase,
      expectedContacts: contacts, actualContacts: contacts,
      desiredGroundForces: [groundForce(0), groundForce(1), groundForce(2), groundForce(3)],
      actualGroundForces: [groundForce(0), groundForce(1), groundForce(2), groundForce(3)],
      solverStatus: 'solved', solverIterations: 35, solverMeanMs: 0.52, solverMaxMs: 1.1,
      qpFailureCount: 0, touchdownEventCount: sequence % 10_000,
      onTimeTouchdownCount: sequence % 10_000, lateTouchdownEventCount: 0,
      earlyTouchdownEventCount: 0, touchdownTimeoutCount: 0,
      touchdownLatencyMeanMs: 1.2, touchdownLatencyMaxMs: 3.4, touchdownLatencyP95Ms: 2.8,
      footSlipSummary: 0.001, jointLimitClipCount: 0, actuatorSaturationCount: 0,
      faultReason: null,
    },
    performance: {
      physicsFrequencyHz: 500, controlFrequencyHz: 100, posePublishFrequencyHz: 60,
      telemetryPublishFrequencyHz: 50, realTimeFactor: 1,
      physicsStepMeanMs: 0.05, physicsStepMaxMs: 0.17,
      controlStepMeanMs: 0.54, controlStepMaxMs: 1.15,
      droppedPoseEvents: 0, droppedTelemetryEvents: 0, catchUpStepCount: 0,
    },
  }
}

export function createD6Pose(sequence: number): RobotPose {
  const telemetrySequence = Math.floor(sequence * D6_CHROMIUM_SOURCE_HZ / D6_CHROMIUM_POSE_SOURCE_HZ)
  const telemetry = createD6Telemetry(telemetrySequence)
  return {
    sequence, simulationTime: sequence / D6_CHROMIUM_POSE_SOURCE_HZ,
    wallTime: 1_780_000_000_000 + sequence * 1000 / D6_CHROMIUM_POSE_SOURCE_HZ,
    rootPosition: telemetry.root.position, rootOrientation: telemetry.root.orientation,
    joints: telemetry.joints.map(({ name, position }) => ({ name, position })),
  }
}

export function startD6ChromiumWorkload(mode: 'dynamic' | 'static'): () => void {
  const counters: D6ChromiumWorkloadCounters = {
    mode, sourceTelemetry: 0, sourcePose: 0, storeTelemetryUpdates: 0,
    storePoseUpdates: 0, robotPanelRenders: 0, activeTimers: 0,
    startedAt: performance.now(),
  }
  window.__D6_CHROMIUM_POC__ = counters
  let telemetrySequence = 1
  let poseSequence = 1
  const telemetryBuffer = new RobotTelemetryBuffer(D6_CHROMIUM_FRONTEND_INTERVAL_MS)
  const publishTelemetry = telemetryBuffer.subscribe((telemetry) => {
    counters.storeTelemetryUpdates += 1
    useAppStore.setState((state) => ({ simulation: {
      ...state.simulation, latestTelemetry: telemetry, latestMotionCommand: telemetry.command,
    } }))
  })
  let pendingPose: RobotPose | null = null
  const publishPose = globalThis.setInterval(() => {
    if (!pendingPose) return
    const pose = pendingPose
    pendingPose = null
    counters.storePoseUpdates += 1
    useAppStore.setState((state) => ({ simulation: { ...state.simulation, latestPose: {
      sequence: pose.sequence, simulationTime: pose.simulationTime, updatedAt: pose.wallTime,
      rootPosition: pose.rootPosition, rootOrientation: pose.rootOrientation, joints: pose.joints,
    } } }))
  }, D6_CHROMIUM_FRONTEND_INTERVAL_MS)
  const initialTelemetry = createD6Telemetry(telemetrySequence++)
  pendingPose = createD6Pose(poseSequence++)
  telemetryBuffer.update(initialTelemetry)
  useAppStore.setState((state) => ({ simulation: {
    ...state.simulation, desktop: true, processState: 'ready', simulationState: 'running',
    selectedModelId: 'unitree-go2-menagerie', model: MODEL, speed: 1,
    lastError: null, latestTelemetry: initialTelemetry, latestMotionCommand: initialTelemetry.command,
    latestCollisionEvent: null, busy: false, visualMode: 'official-mesh', followRobot: true,
  } }))
  if (mode === 'static') {
    globalThis.clearInterval(publishPose)
    pendingPose = createD6Pose(1)
    const pose = pendingPose
    useAppStore.setState((state) => ({ simulation: { ...state.simulation, latestPose: {
      sequence: pose.sequence, simulationTime: pose.simulationTime, updatedAt: pose.wallTime,
      rootPosition: pose.rootPosition, rootOrientation: pose.rootOrientation, joints: pose.joints,
    } } }))
    counters.storePoseUpdates = 1
    return () => { publishTelemetry(); telemetryBuffer.dispose(); counters.activeTimers = 0 }
  }
  const telemetryTimer = globalThis.setInterval(() => {
    counters.sourceTelemetry += 1
    telemetryBuffer.update(createD6Telemetry(telemetrySequence++))
  }, 1000 / D6_CHROMIUM_SOURCE_HZ)
  const poseTimer = globalThis.setInterval(() => {
    counters.sourcePose += 1
    pendingPose = createD6Pose(poseSequence++)
  }, 1000 / D6_CHROMIUM_POSE_SOURCE_HZ)
  counters.activeTimers = 3
  return () => {
    globalThis.clearInterval(telemetryTimer)
    globalThis.clearInterval(poseTimer)
    globalThis.clearInterval(publishPose)
    publishTelemetry()
    telemetryBuffer.dispose()
    counters.activeTimers = 0
  }
}
