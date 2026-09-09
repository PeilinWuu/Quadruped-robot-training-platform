# Go2 motion playback assets

`convert_kine2go_motion.py` converts one Kine2Go `motion.npy` clip into the
small, browser-native playback format used by the application. It does not run
inverse kinematics, dynamics, or policy inference.

The initial asset is Kine2Go `solo8_walk`, whose upstream subset is licensed
under BSD-3-Clause. Preserve the adjacent source metadata and license when
redistributing the generated asset.

The converted clip remains a versioned asset, but the current viewer defaults
to a procedural gait in `robotMotionPlaybackService`. WASD/QE controls its root
transform. The office_01 demo now includes rectangular air-wall constraints,
a ground height lookup and a separate static step IK example. None of these
is a MuJoCo dynamics simulation. See [architecture](../../docs/ARCHITECTURE.md)
and [step demo](../../docs/LOCAL_STEP_STANDING_DEMO.md).
