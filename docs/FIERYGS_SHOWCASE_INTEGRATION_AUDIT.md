# FieryGS Showcase Integration Audit

审计日期：2026-08-27  
项目根目录：`C:\Users\Administrator\Documents\quadruped_robot_research`

## 1. Repository Map

真正的 Windows 展示项目就是仓库根目录，而不是 `FieryGS` 或 `tools/interiorgs-structured-viewer`：

```text
C:\Users\Administrator\Documents\quadruped_robot_research
├─ package.json                       React/Vite/Tauri 项目入口
├─ src/                               主 UI、Viewer、Robot、service/adapter
├─ public/                            Go2 GLB 视觉资产；本地开发 SOG 入口
├─ server/                            浏览器开发模式 Express 服务
├─ src-tauri/                         Windows 桌面宿主、场景库、仿真进程管理
├─ native/mujoco-sidecar/             MuJoCo + 控制器原生 sidecar
├─ tools/interiorgs-structured-viewer 独立的审计/原型 Viewer，不是最终宿主
└─ FieryGS/                           FieryGS 研究代码和适配器，不是 UI 项目
```

项目身份与入口：

| 项目 | 路径 | 角色 | 启动入口 |
|---|---|---|---|
| Windows 展示宿主 | 仓库根目录 | 最终 UI 与 3D 展示宿主 | `src/main.tsx` → `src/App.tsx` |
| Tauri 桌面层 | `src-tauri` | Windows WebView、场景导入、MuJoCo sidecar | `src-tauri/src/main.rs` / `lib.rs` |
| 3D Viewer | `src/features/gaussian-viewer` | PlayCanvas 3DGS + Robot overlay | `GaussianViewport.tsx` |
| FieryGS | `FieryGS` | 离线模拟与原生 CUDA 渲染 | Python 入口；本轮不改 |
| InteriorGS 原型 Viewer | `tools/interiorgs-structured-viewer` | 已有 GS/语义/稀疏火焰验证 | `main.ts`；仅作为迁移参考 |

当前 Git 工作区已有未跟踪的 `FieryGS/`、`tools/`、`tmp/` 等内容。本轮只新增本文档，没有整理或删除这些用户资产。

## 2. UI Architecture

技术栈：

- React 19 + TypeScript 6
- Vite 8
- Ant Design 6 + Lucide React
- Zustand 状态管理
- Tauri 2 Windows 桌面宿主
- Express 5 仅用于浏览器开发/认证后端

真实组件结构：

```text
main.tsx
└─ App
   └─ AuthenticatedApp
      └─ Dashboard
         ├─ Header
         ├─ SceneSidebar
         ├─ center-column
         │  ├─ SimulationView
         │  │  └─ GaussianViewport (lazy)
         │  ├─ TrainingPanel
         │  └─ ChartsPanel
         ├─ right-column
         │  ├─ SensorPanel
         │  ├─ MapPanel
         │  └─ RobotPanel
         └─ StatusBar
```

关键文件：

- 页面与生命周期：`src/App.tsx`
- 中央仿真工具栏和 3D 视口：`src/components/SimulationView.tsx`
- 机器人状态、WASD 开关、跟随控制：`src/components/RobotPanel.tsx`
- 场景导入/选择界面：`src/features/gaussian-viewer/GaussianViewport.tsx`
- 全局状态与 simulation actions：`src/store/useAppStore.ts`

UI 已有 Play/Pause、模型选择、仿真倍速、视角按钮、场景库、RobotPanel 和 Follow Robot。顶部的“自由视角/跟随/第一人称”部分按钮仍是预留提示；实际鼠标 orbit/pan/zoom 和 RobotPanel 中的跟随已经有代码。

## 3. Viewer Architecture

### 3.1 引擎和 3DGS 支持

3D 引擎是 PlayCanvas `2.21.1`，要求 WebGL2。没有使用 Three.js 或 Babylon.js。

主加载链：

```text
GaussianViewport
↓
useGaussianViewer
↓ dynamic import
createViewerRuntime
↓
PlayCanvasGsRuntime
↓
fetch scene.sog → Blob URL → PlayCanvas Asset(type = gsplat)
↓
Entity.addComponent('gsplat', { asset })
```

当前主程序明确支持 3DGS，但只接受 PlayCanvas SOG v2：

- `SceneRecord.sourceFormat` 固定为 `sog`。
- 桌面导入器只允许 `.sog`。
- 文件存储名固定为 `scene.sog`。
- 前后端都有 50 MiB 上限。
- Rust 会验证 SOG ZIP、`meta.json` version 2、count，以及 means/scales/quats/sh0/shN 引用。
- 主程序不能直接加载 `3dgs_explicit.ply`。

### 3.2 Camera 和 Render Loop

- Camera 创建：`src/features/gaussian-viewer/renderer/PlayCanvasGsRuntime.ts`
- 输入控制：`src/features/gaussian-viewer/renderer/PlayCanvasCameraController.ts`
- 左键拖动 orbit；中键、右键或 Shift 拖动 pan；滚轮 zoom。
- 已有 `followTarget()`，收到机器人 pose 时可平滑跟随 root。
- 场景载入后根据 GS AABB 自动设置 target、distance、near/far。
- PlayCanvas `app.start()` 提供 RAF/update loop。
- Runtime 在可见时 `autoRender=true`；隐藏时暂停绘制。
- `app.on('update')` 当前更新 Robot overlay；GS 系统的 `frame:request` 可请求下一帧。

这意味着 Fire overlay 应加入同一个 `PlayCanvasGsRuntime` 的 Application/root 和 update loop，不应创建第二个 canvas 或独立 Viewer。

## 4. Robot Architecture

### 4.1 Go2 是否能显示

能。桌面模式收到 MuJoCo pose 后，`RobotOverlayRuntime` 显示 Go2。

视觉链：

```text
RobotOverlayRuntime
↓
RobotRigFactory
↓
Go2MeshRig
├─ Go2PrimitiveRig（加载期间/失败回退）
└─ MuJoCo Menagerie OBJ 转换所得分件 GLB
```

资产位于：

`public/robot-visuals/unitree-go2/generated/*.glb`

来源与装配参数记录于：

- `src/features/gaussian-viewer/robot/go2VisualManifest.ts`
- `src/features/gaussian-viewer/robot/go2Visuals.lock.json`
- `src/features/gaussian-viewer/robot/go2RigDefinition.ts`

模型单位来自 MuJoCo（米）。视觉层默认 scale 为 1；场景对齐可通过 `RobotOverlayCalibration` 设置 translation、quaternion 和 uniform scale。

### 4.2 Go2 是否能移动

能，但现有正式路径依赖 Tauri + MuJoCo sidecar，不是简单 browser root-transform controller：

```text
RobotPanel KeyboardLocomotionController
↓ 20 Hz heartbeat MotionCommand
simulationService
↓
tauriSimulationAdapter
↓
Tauri simulation manager/process
↓
native/mujoco-sidecar
↓ pose/telemetry events
useGaussianViewer
↓
RobotOverlayRuntime → PoseInterpolator → Go2 rig
```

W/S 生成前后速度，A/D 生成 yaw rate；Space 清除运动目标，R 重置，Esc 解除键盘控制。键盘控制只在 Go2、simulation running、未跌倒且 controller 无 fault 时启用。侧移固定为 0。

当前 Go2 有 12 个可驱动关节，并可显示 MuJoCo/MPC 产生的步态姿态。项目没有独立的 GLTF animation clip 或可脱离仿真的 walk/turn 动画。因此：

- “现有 MuJoCo 模式”有动态关节步态；
- “绕过 MuJoCo 的展示模式”目前没有 gait animation；第一版只能新增站立 pose + root transform 移动，符合本项目 MVP 要求。

### 4.3 Robot overlay 对展示模式的适配性

适配性良好。`RobotOverlayRuntime` 已把视觉 rig、pose 插值、可见性和场景对齐从 simulation service 分开。后续可新增一个轻量 showcase pose source，而无需删除或重写 MuJoCo。

## 5. Simulation Architecture

现有 abstraction 是可复用的：

```text
React UI / Zustand
↓
ManagedSimulationService (`simulationService` singleton)
↓ runtime selection
├─ browserSimulationAdapter（明确返回 DESKTOP_ONLY）
└─ tauriSimulationAdapter
   ↓ Tauri commands/events
   └─ MuJoCo sidecar process
```

关键文件：

- `src/services/simulation/simulationService.ts`
- `src/services/simulation/types.ts`
- `src/services/simulation/browserSimulationAdapter.ts`
- `src/services/simulation/tauriSimulationAdapter.ts`
- `src-tauri/src/simulation/*`
- `native/mujoco-sidecar/*`

MuJoCo 仍被桌面 UI 的启动、姿态、碰撞、遥测、MPC/WASD 路径实际使用。它不是死代码，不应删除。

但它可以被展示 MVP 绕过：Viewer 和 Robot rig 并不直接依赖 MuJoCo，只依赖 `RobotPose`。建议未来增加明确的 `showcase-root-transform` 模式或 adapter，而不是伪装成 MuJoCo 状态。现有 browser adapter 目前不能显示机器人，也不能导入场景，因此完整 MVP 应以 Tauri 为第一目标。

## 6. Existing Fire / Volume Code

### 6.1 发现结果

主 `src/` Viewer 目前没有火焰 renderer、3D texture、ray marching 或 volume component。`SensorPanel`/`MapPanel` 中的火焰只是 CSS/图标展示。

但是存在一个独立的 PlayCanvas 原型：

`tools/interiorgs-structured-viewer/main.ts`

它已经完成：

- 与 `scene_yup.sog` 同 canvas 显示；
- 读取 `fire_manifest.json` 和 `fire_frames.bin`；
- 校验自定义 `FGS1` binary；
- 建立 frame offset index；
- 由 `app.on('update', dt)` 按 FPS 循环换帧；
- 将原始 InteriorGS/FieryGS 坐标变换为 PlayCanvas Y-up；
- 支持 Play/Pause、scrub、聚焦火源；
- 每帧把稀疏 active voxels 拆成 flame/smoke 两组 point cloud。

现有输入 `D:\interiorgs_data\office_01\fire_preview` 是 40 帧、8 FPS、128³、约 0.67 MiB 的早期预览。每条 active voxel 记录是 5 bytes：`gx, gy, gz, temperature, fuel`。

### 6.2 能力边界

这不是 FieryGS 原生的高质量体积渲染：

- Flame 是 `PRIMITIVE_POINTS` + additive alpha；
- Smoke 是 `PRIMITIVE_POINTS` + normal alpha；
- fragment shader 只画径向衰减圆点；
- 没有视线积分、3D texture、深度感知 volume ray marching 或原生 FieryGS importance sampling；
- 没有与 GS depth 做正确的前后遮挡/透射合成。

结论：它是动态数据格式、坐标和播放控制的优秀迁移原型，但最终视觉层要替换为真正的 GPU volume renderer。迁移时不要复制整个独立页面，只提取数据解析、帧索引和坐标规则。

## 7. Coordinate Systems

代码中可以确认的坐标关系如下：

| 系统 | Forward | Up | Right | 单位 | 证据/变换 |
|---|---:|---:|---:|---|---|
| PlayCanvas 展示世界 | `+X`（机器人约定） | `+Y` | `+Z` | m | Environment 平面为 XZ；Camera world up 是 Y |
| MuJoCo Go2 | `+X` | `+Z` | `-Y`（换算到展示 right） | m | 原模型是 Z-up；代码 `mujocoPositionToPlayCanvas([x,y,z]) = [x,z,-y]` |
| InteriorGS/FieryGS 原始 | 水平 `+X` | `+Z` | 原始 `-Y` 对应 Viewer `+Z` | m | 原型注释和 `world()`：`[x,y,z] → [x,z,-y]` |
| `scene_yup.sog` | 已转换至 PlayCanvas basis | `+Y` | Viewer `+Z` | m | 文件名、原型直接 identity 加载、overlay 使用同一 `world()` |
| Camera | 观察方向由 orbit 决定 | Y-up | 相机 local right | m | `lookAt(target, frame.up)`，基础 up `[0,1,0]` |

严格的矩阵表示：

```text
p_viewer = M * p_original

M = [ 1  0  0
      0  0  1
      0 -1  0 ]

(x, y, z)original → (x, z, -y)viewer
```

注意：室内场景本身没有天然“forward”语义；表中 `+X forward` 是为了与 Go2 root/controller 约定统一。最终初始朝向和出生点必须通过可视验证确定，不能只凭轴名决定。

对齐建议：为整个动态环境定义一个唯一 `environmentRoot`，其下同时挂载 GS 和 Fire；Go2 使用单独 `robotAlignmentRoot`。不要分别手写两个近似旋转，否则火源会与桌子漂移。

## 8. office_01 Integration

原始核心文件：

- `D:\interiorgs_data\office_01\3dgs_explicit.ply`
- 927,067 Gaussians，SH degree 3，约 218.8 MB

主 Viewer 不能直接加载该 PLY；它要求 SOG v2。不过当前已有：

- `D:\interiorgs_data\office_01\scene.sog`，约 15.07 MB
- `D:\interiorgs_data\office_01\scene_yup.sog`，约 15.12 MB

因此 MVP-1 无需再次转换大 PLY。应在 Tauri 场景库中导入 `scene_yup.sog`。它低于 50 MiB 限制，并且已经与现有 structured viewer 的 overlay/fire 坐标验证一致。

若未来必须从 explicit PLY 重建展示资产，应使用受控的离线 PLY → PlayCanvas SOG v2 转换，并固定以下验收：Gaussian 数量/SH、旋转和 scale 不错位、Y-up 变换只应用一次、AABB 与桌/沙发/窗帘 bbox 对齐。不要在浏览器运行时转换。

MVP-1 仍需记录一份场景展示配置：

- `environmentTransform`（预期 scene_yup 为 identity）；
- floor height；
- Go2 spawn position/yaw；
- Go2 calibration scale；
- default camera target/distance/orientation；
- source SOG hash/version。

目前 SceneRecord 只持久化 orientation，没有 translation、scale、floor/spawn/camera 元数据。第一版可使用 office_01 专用配置文件，后续再决定是否扩展 Tauri 数据库。

## 9. FieryGS Playback Integration

### 9.1 原始生产数据审计

Table HIGH 生产目录：

`D:\interiorgs_data\office_01\production_regression\table_high\sim_output`

每个主要字段有 200 个 NPZ：

- `fuel`: float32 `[252,203,71]`
- `temperature`: float32 `[252,203,71]`
- `occupancy`: float32 `[252,203,71]`
- `wood_temperature`: float32 `[252,203,71]`
- `color`: float32 `[252,203,71,3]`

体素尺寸是 0.05 m；原始网格 bbox：

```text
min = [-2.65, -7.50, -0.20]
max = [ 9.95,  2.65,  3.35]
```

FieryGS 原生 renderer 实际以 fuel/query tensor 做 ray marching，通过 `fuel2temp` 得到温度，再计算火焰和烟雾；depth map 用于与 Gaussian 合成。科研原始数据必须保留不动。

### 9.2 展示副本字段

推荐最小展示语义：

- `density/fuel`：体积密度和主查询字段，必需；
- `temperature`：若浏览器实现与 FieryGS 一致且有冻结的 `fuel2temp` LUT，可由 fuel 推导；否则量化保存，避免 JS 中复刻模型差异；
- `smoke`：若冻结 renderer 的 smoke contribution 可由 fuel/temperature 计算，则不重复保存；如果无法严格复现，应离线导出一条量化 smoke density channel；
- `bboxMin`, `bboxMax`, `voxelSize`, `dimensions`, `worldFromGrid`：必需；
- `frameIndex`, `fps`, loop range/stage metadata：必需；
- `occupancy/wood_temperature`：仅在需要物体碳化或实体变化时保存；MVP-2 火焰/烟雾播放可以不传完整场景 occupancy；
- `color`：不建议把全网格 RGB 逐帧搬到前端。优先使用冻结的温度到颜色 LUT。

### 9.3 候选资产格式

不要复用“每帧一个 NPZ”。推荐一个 manifest + 分段 binary：

```text
public/fire-playback/office_01/table_high/
├─ metadata.json
├─ frames_000_059.bin
├─ frames_060_119.bin
└─ frames_120_199.bin
```

`metadata.json` 至少包含：

```text
schemaVersion
scenarioId / sourceMode = native_reignite
sourceFrameCount / playbackFrameCount / fps
loopStart / loopEnd
stageRanges (established, spread, late)
gridDimensions / voxelSize
gridToViewer 4x4 matrix
per-frame active bbox and binary offset/length
channels, quantization min/max, compression
source hashes and frozen render profile
```

推荐两级数据方案：

1. MVP/兼容路径：active bbox 内的稠密 `R8`/`RG8` blocks，上传 PlayCanvas/WebGL2 3D texture。
2. 稀疏度很高时：磁盘使用 sparse bricks 或 RLE；解码后仍更新固定尺寸/brick 3D texture，不直接画圆点。

当前全局 dimensions 均小于 256，旧 FGS1 的 uint8 grid index 恰好可表达，但新格式不应把这一偶然限制写死；使用 uint16 dimensions/coordinates 或 manifest-defined brick coordinates。

### 9.4 压缩策略

- 空间裁剪：对 loop 区间求 union active bbox；再加 1–2 voxel 安全边界。
- 量化：展示副本将 `[0,1]` density/temperature 量化为 uint8；需要更平滑时只对关键 channel 用 uint16。
- 时间：从生产 200 帧中选择 ESTABLISHED → SPREAD → 部分 LATE；初始建议 12–15 playback FPS。
- 插值：固定 grid/bbox 后在 GPU 对 frame N/N+1 两张 3D texture 线性混合；若 bbox 每帧变化，需先映射到共同 texture domain。
- 分段加载：先取第一 chunk 开播，后台预取下一 chunk，避免一个巨大 fetch。
- 不修改或覆盖原始 NPZ；转换输出放到新展示资产目录。

### 9.5 Service 和 Renderer 分层

建议新增：

```text
src/services/fire-playback/
├─ types.ts
├─ firePlaybackService.ts
└─ browserFireAssetAdapter.ts

src/features/gaussian-viewer/fire/
├─ FireVolumeRuntime.ts
├─ FirePlaybackAsset.ts
└─ shaders/
   ├─ fire-volume.vert.glsl (或 TS shader string)
   └─ fire-volume.frag.glsl
```

职责边界：

```text
FirePlaybackService
  loadScenario / play / pause / reset / seek / loop / update(dt)
  管理时间、frame/chunk、解码和预取

FireVolumeRuntime
  管理 3D textures、bbox proxy、shader uniforms、GPU 资源
  render(currentFrame, nextFrame, alpha)

React UI
  只订阅状态并调用 service
```

最自然的挂载点是 `PlayCanvasGsRuntime`：在它创建 PlayCanvas `Application` 后创建 `FireVolumeRuntime`，在同一个 `handleUpdate` 驱动 playback/update，在 scene unload/dispose 时释放 GPU 资源。Fire entity 应与 GS entity 共享 `environmentRoot`/同一个 transform。

深度合成是主要技术风险。旧点云可用普通 depth test，但真正 volume 必须取得 GS depth 或采用与 GS 可兼容的渲染层/深度策略，否则火焰会错误地穿墙。MVP-2 可以先验证相机外部和开阔视角，但验收不能忽略墙体遮挡。

## 10. UI Integration

不重写布局。最自然位置是 `SimulationView` 的现有 `.sim-toolbar` / play controls，增加一个小型 Fire control group：

```text
Fire: [Play/Pause] [Reset]
Scenario: [Table HIGH]
Stage: ESTABLISHED → SPREAD → LATE (read-only MVP)
```

不要复用 MuJoCo 的 Play/Pause 按钮来控制火灾，两者时间轴独立。后续可加 Table/Sofa/Curtain、scrubber 和 loop switch。

状态建议放在独立 Zustand fire slice 或独立 service subscription，避免继续膨胀 simulation state。`GaussianViewport` 只需要显示加载错误/体素统计等 Viewer 状态，不应保存 playback 业务逻辑。

第一阶段视角：

- 自由观察已由鼠标 orbit/pan/zoom 支持；
- Follow Go2 已存在，默认应关闭；用户主动开启时相机会持续锁定机器人；
- Robot camera 仍未实现，放到 MVP-4；
- Toolbar 中当前“自由视角”按钮的预留提示应在相关 MVP 中改为真实 mode 切换。

## 11. MVP Plan

### MVP-0：恢复现有 Windows 项目

- 运行 Tauri 桌面项目；
- 确认 UI、PlayCanvas、场景库、Go2 GLB、MuJoCo sidecar；
- 不修 FieryGS、不转换资产。

验收：桌面窗口启动；Go2 model 可选；3D viewport 能绘制；无 WebGL2/context 错误。

### MVP-1：office_01 + Go2，无火

- 通过现有场景导入 UI 选择 `D:\interiorgs_data\office_01\scene_yup.sog`；
- 确认 identity orientation；若不是只使用一次现有 orientation 控件校准；
- 关闭/替换默认 flat-ground overlay，避免与室内 GS 地面重叠；
- 记录 floor height、spawn、yaw、camera preset；
- 先用站立 pose 验证 Go2 尺寸和桌椅相对尺度；再决定是否启 MuJoCo。

### MVP-2：Table HIGH 三维火灾播放

- 编写独立离线转换工具，从 200 帧生产 NPZ 生成只读展示副本；
- 选择 ESTABLISHED → SPREAD → 部分 LATE 的 loop；
- 新增 service + FireVolumeRuntime；
- 与 GS 共用 transform 和 camera；
- Play/Pause/loop，验证多视角与墙体遮挡。

### MVP-3：最低可展示闭环

- Fire playback 持续播放；
- Go2 WASD；
- 鼠标自由视角；
- 火灾时间轴与机器人控制互不阻塞。

如果 MuJoCo 阻塞，新增明确的 root-transform 展示 adapter；站立姿态移动可先验收。

### MVP-4：展示增强

- walk/turn animation 或程序化 gait；
- 简单场景 collision/nav bounds；
- Follow camera 完善；
- Robot camera。

### MVP-5：多场景与产品化

- Table/Sofa/Curtain 切换；
- 统一 Fire UI 和错误恢复；
- 资产缓存、预加载、GPU budget 与发布打包。

## 12. Risks

| 风险 | 当前事实 | 缓解 |
|---|---|---|
| GS 格式不兼容 | 主 Viewer 只接受 SOG，不接受 PLY | MVP-1 复用已有 `scene_yup.sog` |
| 重复坐标变换 | scene_yup 已旋转，SceneRecord 还能再旋转 | 统一 environment transform，记录矩阵，只应用一次 |
| Fire/GS 深度错误 | 旧 fire 是 points，无 GS depth-aware volume compositing | MVP-2 优先验证深度接入方案 |
| 火焰质量退化 | 点云圆片与 FieryGS ray marching 差距大 | 旧代码只作 parser 原型，新建 3D texture volume runtime |
| GPU 内存 | 927k GS + 双 3D texture + Go2 同时存在 | active bbox、R8/RG8、双缓冲、固定 GPU budget |
| 带宽/启动延迟 | 原始全场 float32 NPZ 不适合 WebView | 量化、裁剪、chunk、预取、缓存 |
| 50 MiB 限制 | Scene 导入限制仅面向单 SOG | office SOG 15 MB 可用；Fire 用独立受控协议/asset loader |
| Go2 与场景碰撞 | MuJoCo 当前只知道 flat-ground，不知道 GS geometry | MVP-3 可展示移动；collision/nav 推迟 MVP-4 |
| MuJoCo 耦合 | 当前 WASD 只在桌面 running 仿真可用 | 保留现有路径；必要时新增 root-transform adapter |
| gait animation 缺失 | 没有独立 animation clips | MVP-3 允许站立 root 移动；MVP-4 再做 gait |
| Browser 模式能力不足 | browser adapters 禁止场景导入/Robot | 第一展示目标用 Tauri；以后再扩展 browser asset adapter |
| 生产状态语义 | `fuel`、温度和 smoke 的视觉映射依赖冻结 renderer | 转换工具记录源哈希、LUT、阈值、profile，做原生渲染对照图 |
| 科研数据被误改 | 生产 NPZ 和 Dataset v1 是基准资产 | 输出到新 `fire-playback` 目录，转换只读 |

## 13. Exact Files To Modify

### MVP-1 预计修改

优先最小化。导入 `scene_yup.sog` 本身不需要代码修改；若要把 office_01 固化成可重复展示配置，预计修改/新增：

- `src/features/gaussian-viewer/renderer/PlayCanvasGsRuntime.ts`  
  引入统一 environment root / 应用展示配置；场景载入时正确处理默认 ground。
- `src/features/gaussian-viewer/robot/RobotOverlayRuntime.ts`  
  继续复用 calibration root；允许从 office 展示配置设置 spawn/alignment。
- `src/features/gaussian-viewer/useGaussianViewer.ts`  
  在 current scene 变化时装载对应展示配置，不硬编码到 UI。
- `src/features/gaussian-viewer/GaussianViewport.tsx`  
  仅显示/选择场景 preset 和校准状态（如确有需要）。
- 新增 `src/features/gaussian-viewer/environment/office01ShowcaseConfig.ts`  
  保存 SOG identity transform、floor、spawn、camera preset；最终数值须人工目测确认。
- 对应测试：`src/features/gaussian-viewer/environment/tests/*`、`src/features/gaussian-viewer/robot/tests/RobotOverlayRuntime.test.ts`。

不预计修改 `src-tauri/src/scenes/*`：现有 import、validation、orientation 和 50 MiB 限制已经能容纳 `scene_yup.sog`。

### MVP-2 预计新增/修改

- 新增 `FieryGS/adapter/fire_showcase/export_fire_playback.py`  
  只读转换生产 NPZ，输出裁剪/量化/chunk 展示资产；不改 solver。
- 新增 `src/services/fire-playback/types.ts`
- 新增 `src/services/fire-playback/firePlaybackService.ts`
- 新增 `src/services/fire-playback/browserFireAssetAdapter.ts`
- 新增 `src/features/gaussian-viewer/fire/FireVolumeRuntime.ts`
- 新增 `src/features/gaussian-viewer/fire/FirePlaybackAsset.ts`
- 修改 `src/features/gaussian-viewer/types.ts`  
  增加 Fire runtime/status contract。
- 修改 `src/features/gaussian-viewer/renderer/PlayCanvasGsRuntime.ts`  
  创建、更新和释放 Fire runtime；共享 environment transform。
- 修改 `src/features/gaussian-viewer/useGaussianViewer.ts`  
  连接 service 与 Viewer runtime。
- 修改 `src/components/SimulationView.tsx`  
  加入最小 Fire/Scenario controls。
- 修改 `src/App.css`  
  只增加现有 toolbar 风格下的小型控制样式。
- 修改 `src-tauri/tauri.conf.json` 或新增受控 Tauri asset protocol（仅当展示资产不随 public 打包时）。

不要把 `tools/interiorgs-structured-viewer/main.ts` 直接变成第二个产品 Viewer；它只作为 FGS1 parser、播放时钟和坐标转换的参考来源。

## Audit Conclusion

融合路径可行，而且旧项目比预想更接近目标：它已经拥有主 UI、PlayCanvas 3DGS、SOG 场景库、Go2 官方分件网格、12 关节姿态、MuJoCo/MPC WASD、自由 orbit camera 和 follow target。`office_01` 也已有可直接导入的 Y-up SOG。

真正缺失的核心只有一项：把离线 FieryGS 状态做成受控的展示资产，并在现有 PlayCanvas runtime 内加入质量足够的 3D volume playback。旧 structured viewer 已证明坐标和动态帧播放，但其 point-cloud fire 不能作为最终视觉实现。
