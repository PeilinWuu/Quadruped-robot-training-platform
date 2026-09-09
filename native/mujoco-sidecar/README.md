# Quadruped simulation sidecar

This Windows x64 C++17 executable is the native simulation and locomotion process used by the Tauri desktop application. It is no longer a protocol-only test stub.

The current default viewer uses a separate procedural motion service. Tauri's
default dev/build hooks do not build this sidecar, and the default installer
resource list does not bundle its executable or simulation models. Build it
explicitly for native development; see [getting started](../../docs/GETTING_STARTED.md).

The sidecar currently provides:

- MuJoCo 3.11.0 fixed-step simulation;
- the minimal quadruped and Unitree Go2 Menagerie models;
- load, start, pause, step, reset, stop, speed and shutdown commands;
- root pose, 12-joint pose, contact, collision, locomotion and performance telemetry;
- a stand-hold controller;
- Go2 flat-ground Convex MPC locomotion using Eigen, OSQP and QDLDL;
- bounded NDJSON request/response and event transport over stdin/stdout;
- deterministic protocol, MPC core, integration and locomotion acceptance tests.

## Process boundary

The Tauri/Rust `SimulationManager` starts this executable only from the fixed application resource directory, supplies a validated `--resource-root`, correlates request IDs, validates responses and shuts the process down when the desktop application exits.

The sidecar does not open network sockets or start child processes. Protocol responses, collision events and latest-value pose/telemetry events are serialized by a dedicated stdout writer so the 500 Hz physics loop is not blocked by UI delivery.

## Control rates

- MuJoCo physics: 500 Hz (`0.002 s` timestep)
- leg controller: 250 Hz
- Convex MPC: 50 Hz
- default pose publication: 60 Hz
- configurable telemetry publication: 10–100 Hz
- MPC horizon: 10 nodes at `0.02 s` (`0.2 s` total)

The Convex MPC controller is available only for `unitree-go2-menagerie` in `flat-ground-v1`. It accepts bounded forward velocity and yaw-rate targets; lateral velocity is not implemented. This is a simulation controller and must not be represented as a physical Unitree Go2 controller.

## Pinned dependencies

- MuJoCo 3.11.0
- Eigen 3.4.0
- OSQP 1.0.0
- QDLDL 0.1.8
- nlohmann/json 3.12.0 single header

Versions, source URLs and SHA-256 hashes are recorded in `mujoco.lock.json`, `mpc-dependencies.lock.json` and the repository scripts. License copies are bundled under `src-tauri/resources/licenses/` and `LICENSES/`.

## Build and test

Run from the repository root on Windows x64 with Visual Studio 2022 C++ Build Tools and CMake installed:

```bash
npm run setup:mpc
npm run build:sidecar
```

The build script:

1. verifies the committed Go2 Menagerie resources;
2. downloads and verifies pinned MuJoCo when the local cache is absent;
3. requires verified Eigen, OSQP and QDLDL caches;
4. configures and builds the Release targets with CMake;
5. runs CTest protocol, MPC core, integration and acceptance suites;
6. copies only the required executable, MuJoCo DLL, models and licenses into fixed Tauri resource directories.

Generated caches and `native/mujoco-sidecar/build/` are intentionally ignored by Git.
