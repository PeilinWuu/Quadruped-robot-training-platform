# FieryGS Playback V2 — 16-frame prototype

2026-09-08. Prototype implementation and automated performance/interaction checks are complete.
Visual acceptance remains qualified: the native yellow core and orange edge are recovered,
but voxel edges are smoother than native, the source's column shape remains, and occupancy
depth has visible steps. **V1 remains the default; no 72/200-frame export was performed.**

## Review artifacts

- [Side-by-side report](D:/interiorgs_data/office_01/fire_playback_v2/table_high_test/verification/report.html)
- [Six-panel comparison](D:/interiorgs_data/office_01/fire_playback_v2/table_high_test/verification/comparison.png)
- [Raw benchmark](D:/interiorgs_data/office_01/fire_playback_v2/table_high_test/verification/benchmark.json)
- [Memory and latency](D:/interiorgs_data/office_01/fire_playback_v2/table_high_test/verification/extended.json)
- [Controlled automatic degradation check](D:/interiorgs_data/office_01/fire_playback_v2/table_high_test/verification/auto-quality.json)

All comparison panels use source frame 104 and the position, target, up vector and intrinsics
from `fire_scenarios_batch/renders/cameras/table.json` (vertical FOV 60°, aspect 16:9).
Browser output is 1280×720, resized to 640×360 in the contact sheet. Native reference is a
new **single-frame render of existing simulation**, with [64,512], seed 42, strength .005,
smoke .2, native Phong, simulation color, legacy clipping and hdr_aces=false.
Browser SOG and native PLY/plane rasterization differ in background transparency and detail;
this is a visual comparison, not a pixel-equivalence claim.

## Changes and use

Run `npm run dev`, open the normal application, select **V2 原型** in the fire toolbar.
Quality choices are high=128, medium=96, low=64 and off. All V2 levels retain emission+smoke.
The automatic checkbox reduces only fire quality after two consecutive slow measurement
windows (<28 FPS, approximately four seconds); sustained low mode falls back to V1.
Metadata, chunk, texture-upload and detected shader failures also fall back to V1.
The toolbar identifies fallback and retains its reason in a tooltip.

The optional **遮挡** checkbox renders static full-room occupancy geometry into a half-size
live-camera depth target. It clips the volume ray's exit before integration. Proxy geometry
comes from existing occupancy_0 (absolute occupancy > .1), native 5 cm exposed voxel faces,
255868 triangles / 9211248 bytes. It occludes table surfaces/legs and structural foreground
where represented by occupancy. It is NOT an exact GS opacity/depth solution. Thin/translucent
surfaces and dynamic burning material can disagree with RGB. Keep it optional pending review.
The proxy's render camera copies the active camera each frame and receives no input.

Only the fire runtime, fire service/loader/types, fire toolbar, local Vite asset route and test
command were changed. Robot kinematics, animation, WASD/QE handlers, camera controller and
first-person binding were not edited. Large assets, generated binaries and screenshots stay
on D:. Vite serves `/fire-playback-v2/table_high_test/` in development. Production asset hosting
and Tauri packaging are not added by this browser prototype (V1 has the same hosting limit).

## Asset contract

Exporter: `FieryGS/adapter/fire_showcase/export_fire_playback_v2.py`.
Depth exporter: `FieryGS/adapter/fire_showcase/export_fire_depth_proxy.py`.
Formal schema: `docs/fire-playback-v2.schema.json`; runtime types and validation live in
`src/services/fire-playback`. Output:
`D:/interiorgs_data/office_01/fire_playback_v2/table_high_test/metadata.json`.

| Property | Value |
|---|---|
| Source frames | 28,38,46,56,66,76,84,94,104,114,122,132,142,152,160,170 |
| Frames / chunks | 16 / 4 (4 frames per chunk) |
| Crop | [93,60,0], 43×43×71, same as V1 |
| Source bounds | [2,-4.5,-.2] to [4.15,-2.35,3.35] |
| Source → viewer | (x,y,z) → (x,z,-y), row-major metadata matrix |
| Frame / chunk bytes | 1050232 / 4200928 |
| Total sequence bytes | 16803712 (16.03 MiB), excluding optional proxy/reference/QA |
| Playback FPS | 1.690140845 (preserves 8.875 s endpoint span of V1) |
| Memory | 2 decoded frames, at most 2 chunks, 4 RGBA8 GPU atlases |

Disk order is XYZ C order with **eight interleaved bytes per voxel**. GPU atlas reorder makes
X fastest and stacks Z slices along Y. Texture A: signed native linear emission R/G/B,
extinction. Texture B: simulation smoke R/G/B and independent smoke density.

Emission decode: `(byte - 128) * emissionScale`, scale
`[0.35361347885, 0.04947087754, 0.00850587706]`. Byte 128 is exactly zero.
Scale is fixed across all selected frames; maximum absolute coefficient quantization error
is .176803. Other channels decode byte/255 in [0,1]. Extinction is 1 where fuel>0; smoke
uses the native .001/.6 gates. Source strength .005 is already baked into emission.

The exporter reproduces the native 101-sample Planck/CIE table and CAT02/linear-sRGB matrices.
It intentionally **does not bake gamma/clipped display RGB**: gamma and legacy clipping
occur after front-to-back RGB coefficient integration, then integrated smoke×.2 and native
smoke-path ACES(exposure=.8). hdr_aces remains false. Signed coefficients are an intermediate
linear representation, not the previously rejected unclipped display-HDR mode.

Spatial emission interpolation is an approximation to native interpolation of temperature
before blackbody evaluation. Exponential extinction replaces native discrete products;
Phong surface lighting and carbonization are not included. Prototype temporal sampling is
coarse: adjacent source gaps are 8–10 frames, rather than V1's 2; interpolation is continuous,
but fine temporal detail is lost. `frames[].sourceFrame` is authoritative (`frameStep=0`).

## Performance on RTX 4060 Laptop

Edge headless, ANGLE NVIDIA D3D11 hardware verified, real production PlayCanvas runtime,
927067-source-Gaussian SOG scene and Go2 overlay, 1280×720, pixel ratio 1. Each row uses
1.2–2.5 s warmup and 3–4 s frameend measurement. No FPS claim is based on CPU-only tests.

| Mode | Average FPS | P95 frame interval (ms) |
|---|---:|---:|
| Fire off | 60.1 | 17.4 |
| V1 | 60.2 | 17.2 |
| V2 low | 60.1 | 17.2 |
| V2 medium | 60.1 | 17.1 |
| V2 high | 60.2 | 17.1 |
| V2 medium + proxy depth | 60.1 | 17.2 |
| Free view after movement + depth | 60.2 | 17.3 |
| Robot first person + depth | 60.2 | 17.0 |
| Free orbit during movement | 60.0 | 17.3 |

All modes are refresh-capped near 60 FPS, exceeding the 30 FPS medium target in this test.
These are short local measurements, not sustained thermal or full-dashboard/Tauri results.
Observed chunk load+length/hash verification: V1 16.9 ms; V2 22.2–40.5 ms in measured rows.
Initial smoke check observed 59.2 ms; values include local HTTP/copy/SHA256, not disk-only I/O.

Full 16-frame traversal retained 2 frames and 1–2 chunks at every checkpoint. Peak sampled
engine-owned GPU resources (textures, vertex/index/uniform/storage buffers including scene,
robot and proxy) were **79922944 bytes = 76.2 MiB**. V2 fire atlases alone are 2100464 bytes
(2.00 MiB); V1 atlases .50 MiB. `nvidia-smi` sampled 28 times at a requested 250 ms interval:
**1127 MiB whole-GPU peak**, including driver/compositor/other applications. This is not
browser-process exclusive memory, nor a guarantee of an unsampled absolute peak.

Keyboard-event-to-next-pose samples (20 each): V1 mean 8.5 ms/max 15.0; V2 mean 8.9 ms/max
15.9. No added whole-frame input stall was observed. This does not measure physical keyboard
to photon latency or constitute a human subjective latency assessment.

## Regression results

| Required interaction | Evidence/result |
|---|---|
| Left rotate / right pan / zoom | Real browser mouse events changed actual camera pose |
| WASD/QE | Each of six real key events changed robot translation/rotation |
| Joint directions | Existing robot tests pass; motion and joint mapping code unchanged |
| Head RGB follows robot | Actual first-person camera pose changed after W input |
| Repeated FP/free switching | Six round trips returned successfully |
| Play / pause / reset | Advances / holds / returns to frame 0, verified |
| Same fire position in both views | Same active camera identity and volume world transform |
| Camera remains unlocked | Mouse tests pass with fire active |
| Input responsiveness | Latency samples above, no changed input rules |
| V2 failure → V1 | Injected HTTP 404 restored V1 and resumed playback |
| Automatic quality | Controlled 20 FPS injection produced medium → low → V1; playback resumed |

The automatic quality test deliberately resets measurement-window counters before injecting
20 FPS; `auto-quality.json` is authoritative. The earlier `extended.json` includes a warm-window
probe whose first sample still reads high and whose final state precedes playback resumption.

`npm test`: **8 Node + 115 frontend tests pass** (12 new fire loader/service regression tests).
`npm run build`: passes. Existing worker_threads externalization and large-bundle warnings
remain. JSON Schema validation, all four V2 chunk hashes and all original V1 chunk hashes pass.
Both checkpoints remain available: outer `0adff91`, FieryGS `defda1d`.

## Reproduce

No dependency installation is needed. Start `npm run dev`, then run
`node scripts/verify-fire-playback-v2.mjs`. For memory, paired input latency and controlled
automatic degradation run `node scripts/verify-fire-playback-v2-extended.mjs`. The scripts uses the bundled Playwright and installed
Edge, with a local SOG response fixture; `PLAYWRIGHT_MODULE` can override its module path and
`FIRE_QA_OUTPUT` its report directory. Test fixture: `tools/fire-playback-v2/fixture.html`.
It instantiates the production runtime; it does not authenticate or modify a user account.

Exporters refuse existing output files/directories. To regenerate, choose a new directory:

```powershell
python FieryGS/adapter/fire_showcase/export_fire_playback_v2.py --output-dir D:/interiorgs_data/office_01/fire_playback_v2/table_high_test_new
python FieryGS/adapter/fire_showcase/export_fire_depth_proxy.py --metadata D:/interiorgs_data/office_01/fire_playback_v2/table_high_test_new/metadata.json
```

Do not expand beyond this prototype until visual review accepts the remaining edge/depth/
temporal limitations. The exporter currently enforces exactly 16 representative frames.
