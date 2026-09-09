# Playback V2 audit (2026-09-08, before implementation)

Both recovery commits exist: outer `0adff91`, nested FieryGS `defda1d`.
Existing untracked files and nested dependency metadata changes are left alone.

- V1 metadata and disk layout confirmed: 72 × 262558 bytes, XYZ C order,
  interleaved fuel/temperature UNORM8, crop 43×43×71 at [93,60,0].
- Source (x,y,z) maps to viewer (x,z,-y); bounds are source coordinates.
  The recorded sourceToViewer is row-major, while runtime uses this mapping explicitly.
- V1 holds two GPU atlases but its CPU frame/chunk Maps grow without eviction.
  Service interpolates adjacent indices at 8 FPS, ping-pong, using one pending request.
- V1 renders a back-face box after the scene, depth testing disabled; it integrates
  approximate fuel-derived emission and grey smoke with premultiplied blending.
- Free and robot-head modes use the SAME Entity camera. First-person only updates
  that entity pose/FOV. Fire receives that entity. No controller or motion edits needed.
- Native `rendering/volume_utils.py::render_image_fire_smoke` interpolates fuel-derived
  temperature, computes blackbody XYZ at temperature×0.12, accumulates XYZ×0.005×T×dt,
  applies XYZ2RGB legacy gamma/clipping AFTER integration, adds independently integrated
  smoke color×density×0.2, then ACES(exposure=0.8). hdr_aces=false does NOT disable this
  final smoke-path ACES. Fuel>0 gives extinction=1; smoke occupies (0.001,0.6].
  Native clips samples using active-camera plane depth before composition over GS×T.
- Native Phong and carbonization modify the underlying scene separately. A volume-only
  asset cannot reproduce surface illumination or geometry removal; these are limitations.
- Baking clipped display RGB before integration is not equivalent. V2 will bake the
  linear RGB coefficients from the native XYZ/CAT02 matrices with signed per-channel
  ranges, preserving integration then gamma/clipping. Two RGBA8 textures carry those
  coefficients/extinction and simulation smoke RGB/density. No unclipped display HDR path.
- Installed PlayCanvas 2.21.1 source confirms standard alpha GS does not write depth.
  Merely requesting scene depth cannot occlude fire behind GS. Investigate a separate
  active-camera GS prepass or world geometry proxy; keep occlusion independently switchable.

Only 16 representative V1 source indices will be exported, using the identical V1 crop.
No physics is run, no full-sequence conversion, and no generated assets enter Git.
