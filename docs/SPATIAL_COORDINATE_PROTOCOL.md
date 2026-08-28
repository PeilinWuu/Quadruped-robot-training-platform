# Unified spatial coordinate protocol

This protocol is the common boundary between MuJoCo, the physical Go2, and
future camera/LiDAR pipelines. Consumers must not depend on source-specific
axis conventions.

## Canonical convention

- Right-handed ROS-style coordinates: X forward, Y left, Z up.
- Translation is measured in metres; angles are measured in radians.
- Quaternions are serialized in `[x, y, z, w]` order and normalized.
- The initial frame tree is `world -> odom -> base_link`.
- Sensor calibration adds fixed `base_link -> sensor_link` transforms.
- `sourceTimestampMs` belongs to the producer; `hostTimestampMs` records when
  the desktop adapter created the normalized sample.

The current MuJoCo/PlayCanvas output is Y-up. Its canonical mapping is:

```text
[x, y, z] viewer -> [x, -z, y] ROS
```

Quaternion conversion is the corresponding basis change, not a component
reordering. TypeScript and the existing C++ ROS bridge use the same conversion
and share equivalent tests.

## Transform composition

Transforms use `T_parent_child`. Sensor pose is derived as:

```text
T_world_sensor = T_world_odom * T_odom_base * T_base_sensor
```

`T_world_odom` is identity for the first simulation adapter. A later physical
robot origin-alignment step will populate it without changing consumers.

## Physical Go2 origin alignment

The initial real adapter treats `SportModeState.position` as ROS-style local
odometry and combines it with LowState IMU roll/pitch/yaw. This source is marked
`low` confidence until its axes, reset behavior, and drift are measured.

The desktop can align the current real base pose with the current simulation
base pose. It computes `T_world_real_odom` from translation and yaw only:

```text
T_world_base(real, aligned) ≈ T_world_base(simulation, reference)
```

Roll and pitch are deliberately excluded from origin calibration so a slightly
tilted robot does not tilt the shared world or Gaussian scene. The alignment is
currently session-local and must be set again after restarting the desktop.

## Current scope

This stage normalizes MuJoCo and Go2 local pose and exposes both in desktop
diagnostics. It defines sensor-frame types and transform composition but does
not invent Go2 camera extrinsics or treat `SportModeState.position` as globally
accurate. Camera calibration and stronger localization remain separate steps.
