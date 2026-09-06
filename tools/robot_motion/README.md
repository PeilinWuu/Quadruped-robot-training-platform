# Go2 motion playback assets

`convert_kine2go_motion.py` converts one Kine2Go `motion.npy` clip into the
small, browser-native playback format used by the application. It does not run
inverse kinematics, dynamics, or policy inference.

The initial asset is Kine2Go `solo8_walk`, whose upstream subset is licensed
under BSD-3-Clause. Preserve the adjacent source metadata and license when
redistributing the generated asset.

At runtime the clip supplies joint animation only. WASD controls the viewer
root transform and each frame is vertically grounded from the rendered Go2
foot geometry. No MPC, inverse kinematics, collision, or dynamics solver runs.
