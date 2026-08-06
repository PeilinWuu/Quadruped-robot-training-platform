export const JOINT_NAMES = [
  'front_left_hip_abduction', 'front_left_hip_flexion', 'front_left_knee',
  'front_right_hip_abduction', 'front_right_hip_flexion', 'front_right_knee',
  'rear_left_hip_abduction', 'rear_left_hip_flexion', 'rear_left_knee',
  'rear_right_hip_abduction', 'rear_right_hip_flexion', 'rear_right_knee',
] as const

export type QuadrupedJointName = typeof JOINT_NAMES[number]

export interface LegDefinition {
  name: string
  side: 1 | -1
  hipPosition: [number, number, number]
  thighPosition: [number, number, number]
  joints: readonly [QuadrupedJointName, QuadrupedJointName, QuadrupedJointName]
}

// MJCF Z-up local vectors are expressed in PlayCanvas Y-up coordinates: (x,z,-y).
export const LEGS: readonly LegDefinition[] = [
  { name: 'front-left', side: 1, hipPosition: [0.2, 0, -0.13], thighPosition: [0, 0, -0.035], joints: [JOINT_NAMES[0], JOINT_NAMES[1], JOINT_NAMES[2]] },
  { name: 'front-right', side: -1, hipPosition: [0.2, 0, 0.13], thighPosition: [0, 0, 0.035], joints: [JOINT_NAMES[3], JOINT_NAMES[4], JOINT_NAMES[5]] },
  { name: 'rear-left', side: 1, hipPosition: [-0.2, 0, -0.13], thighPosition: [0, 0, -0.035], joints: [JOINT_NAMES[6], JOINT_NAMES[7], JOINT_NAMES[8]] },
  { name: 'rear-right', side: -1, hipPosition: [-0.2, 0, 0.13], thighPosition: [0, 0, 0.035], joints: [JOINT_NAMES[9], JOINT_NAMES[10], JOINT_NAMES[11]] },
]

export const HOME_JOINTS = JOINT_NAMES.map((name, index) => ({
  name,
  position: index % 3 === 0 ? 0 : index % 3 === 1 ? 0.55 : -1.1,
}))
