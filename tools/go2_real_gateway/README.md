# Go2 real-robot Sport gateway

This gateway is the hardware-side boundary for the Unitree Go2 EDU high-level
Sport API. It is intentionally separate from the MuJoCo ROS bridge: the real
robot's `Move` API is a one-shot state command, not a `/cmd_vel` stream.

The default mode is **dry-run**. Publishing to `/api/sport/request` requires
both the `--live` flag and `GO2_REAL_GATEWAY_LIVE=1`. This prevents an accidental
start from moving a connected robot.

## Protocol

The process reads one JSON object per line from stdin and writes one JSON object
per line to stdout. Supported commands are:

```json
{"type":"configure","payload":{"controlEnabled":false}}
{"type":"control_enable","payload":{"enabled":true}}
{"type":"move_once","payload":{"forwardVelocity":0.10,"lateralVelocity":0.0,"yawRate":0.2,"durationMs":1000}}
{"type":"keyboard_motion","payload":{"forwardVelocity":0.10,"lateralVelocity":0.0,"yawRate":0.2}}
{"type":"stop","payload":{}}
{"type":"stand_up","payload":{}}
{"type":"stand_down","payload":{}}
{"type":"lidar","payload":{"enabled":true}}
```

`move_once` sends API 1008 exactly once, waits for the bounded duration, then
sends API 1003 three times as a safety redundancy. Any malformed command,
disabled control source, timeout, stdin EOF, or shutdown path sends StopMove
before exiting. Defaults are conservative: 0.30 m/s forward/lateral, 0.50
rad/s yaw, and 3 seconds maximum duration.

`keyboard_motion` follows the Go2 state-command behavior used by
`go2_wasd_control.py`: the desktop sends API 1008 when the held-key velocity
changes and refreshes the same high-level Move while the key remains held. It
has no duration timeout. Recent physical telemetry is still required before
accepting a new nonzero keyboard motion.

The stdin loop remains responsive while a move is active, so a separate
`{"type":"stop","payload":{}}` line can interrupt the duration immediately.
LiDAR state changes are published in a short 10 Hz burst because field testing
showed that a single state message is not reliably consumed.

The live process expects ROS 2 Humble and `unitree_api` to be sourced in the
environment. It publishes only high-level Sport requests; it does not publish
`/lowcmd` and does not implement joint-level control.
