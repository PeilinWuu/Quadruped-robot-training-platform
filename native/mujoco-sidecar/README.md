# Quadruped simulation sidecar

This Windows/Linux x86_64 C++17 process supplies MuJoCo model transforms and
telemetry to the Tauri desktop application.

For the Unitree Go2 model, movement is intentionally kinematic:

- `forwardVelocity`, `lateralVelocity`, and `yawRate` are integrated directly
  into the floating-base pose at the fixed `0.002 s` timestep;
- a deterministic diagonal gait curve animates the 12 joints for visual
  feedback;
- no MPC, QP solver, force optimization, inverse dynamics, or low-level Go2
  controller is executed;
- clearing or timing out a command freezes the root coordinates and returns the
  joints to the home pose.

This boundary matches the platform goal: the real robot executes Unitree's
high-level Sport commands while the virtual robot follows the same coordinate
trend for scene, camera, and planning work. The animation is illustrative and
must not be treated as a physics or actuator validation.

## Dependencies

- MuJoCo 3.11.0
- nlohmann/json 3.12.0 single header

## Build and test

```bash
npm run setup:mujoco
npm run build:sidecar
```

The build verifies the committed Go2 Menagerie resources and pinned MuJoCo
runtime, compiles the sidecar, runs protocol/coordinate/animation tests, and
copies the executable and runtime into the fixed Tauri resource directories.
