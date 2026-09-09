# 四足机器人第一视角 Gaussian 深度图项目现状

更新时间：2026-09-05

## 1. 项目目标

项目目标是构建建筑室内火灾环境下的四足机器人仿真、监控与感知平台。当前专项目标是：让机器人第一视角相机随 MuJoCo 机器人位姿运动，并从 Gaussian Splatting 场景获得实时深度图，在前端与第一视角 RGB 图之间切换显示。

系统职责边界如下：

- MuJoCo：机器人模型、动力学、运动控制、位姿和遥测。
- Gaussian/PlayCanvas：室内视觉场景、第一视角 RGB 和深度观测。
- FieryGS：Gaussian 深度渲染算法参考、离线基准和深度数据处理。
- React/Tauri：交互、状态管理、渲染调度和桌面封装。

## 2. 已有系统能力

### Gaussian 语义与材料理解

FieryGS/InteriorGS 数据链路已经完成 Gaussian 级材料理解和可燃性标注：

- `gaussianinstancelabels`：Gaussian 实例标签。
- `points_label_mulscale.npy`：多尺度点标签。
- `points_materials.npy`：Gaussian 材料类别。
- `points_burnability.npy`：Gaussian 可燃性标注。
- `objects_material_catalog.json`：对象材料目录。
- `material_quality_report.json`：材料理解质量报告。

当前统计：

- 514 个对象完成材料理解。
- 237 个对象判定为可燃。
- 338,757 个 Gaussian 被标记为可燃。

这意味着项目已经不只是“静态 Gaussian 场景 + 火焰回放”，而是具备了从 Gaussian 实例到材料属性、再到火灾场景初始化的语义基础。后续火焰模拟可以基于对象材料和 Gaussian 可燃性进行空间约束，而不是仅使用固定位置的视觉效果。

### 火灾场景数据

当前已经存在 `table_high` 火灾场景数据，并可作为材料理解、可燃性标注与 FieryGS 火焰渲染之间的验证样本。

### 仿真与机器人

- MuJoCo C++ Sidecar 已接入 Tauri/Rust 生命周期。
- 固定 500 Hz 物理步进，250 Hz 腿控制，50 Hz Convex MPC。
- 已回传根位姿、关节、足端接触、碰撞、IMU、控制状态和性能遥测。
- Unitree Go2 Menagerie 模型和视觉网格已接入。
- 已支持启动、暂停、单步、重置、停止、倍速和运动指令。

### Gaussian 视觉

- PlayCanvas WebGL2 Gaussian Splatting Runtime 已接入。
- 已支持 SOG 场景加载、场景方向、相机轨道控制和 WebGL context 恢复。
- 机器人 Overlay 已将 MuJoCo 位姿同步到 Gaussian 场景。
- 已实现机器人第一视角相机：相机绑定到 Go2 机身前部，并随机器人姿态更新。
- 已实现第一视角开关和自由相机恢复。

### 前端传感器界面

- 传感器面板已支持多视图、第一视角 RGB、第一视角深度、热成像和 LiDAR 切换。
- 默认显示单路第一视角 RGB，减少初始渲染压力。
- RGB 与深度互斥显示。
- 深度模式已经接入真实 FieryGS 深度样本，并支持多帧回放。

## 3. 已确认的真实 Gaussian 数据

场景目录：

```text
D:\interiorgs_data\office_01
```

关键资产：

- `3dgs_explicit.ply`：约 209 MB，完整 Gaussian 参数。
- `3dgs_compressed.ply`：约 54 MB，压缩 Gaussian 参数。
- `scene_yup.sog`：PlayCanvas 使用的 Y-up 场景。
- `fierygs\camera.json`：相机参数。
- `fierygs\fire_camera.json`：火灾相机参数。
- `fierygs\fire_render_frame_028_depth.npy`。
- `fierygs\fire_render_frame_199_depth.npy`。
- `fierygs\fire_render_frame_199_native_depth.npy`。

已生成前端可查看的深度图：

- `public/gaussian-depth-baseline.png`
- `public/gaussian-depth/000.png`
- `public/gaussian-depth/001.png`
- `public/gaussian-depth/002.png`

深度基准帧分辨率为 640×360，有效深度约 1.01–10.42，数据来自 FieryGS Gaussian 深度 rasterizer。

## 4. 当前已完成的深度链路

当前链路为：

```text
FieryGS 深度 NPY
  → 伪彩色 PNG
  → public/gaussian-depth
  → SensorPanel
  → 第一视角深度模式
  → 多帧回放
```

这是真实 Gaussian 深度数据的前端展示，但仍属于离线帧回放，不是随机器人相机位姿变化的实时深度。

## 5. 当前主要阻塞

### PlayCanvas 没有公开 Gaussian 深度输出接口

当前项目使用 PlayCanvas 2.21.1 的 GSplat Runtime。应用层能够控制场景、相机、资产和渲染生命周期，但不能直接取得 Gaussian rasterizer 内部的线性深度输出。

普通 WebGL canvas 深度缓冲不能直接解决问题：

- Gaussian splat 是透明/半透明 primitive，不等同于普通三角网格。
- 深度依赖 Gaussian 排序、覆盖和 alpha 贡献。
- 颜色 pass 的深度缓冲不一定代表 FieryGS 定义的表面深度。
- CPU `readPixels` 会产生同步阻塞，不适合持续实时读取。

### FieryGS 与 PlayCanvas 的运行时不同

FieryGS 的 `render_with_depth()` 使用 PyTorch CUDA 和 `diff-gaussian-rasterization-depth`。它可以输出高质量 Gaussian 深度，但不能直接嵌入当前浏览器/桌面 PlayCanvas 渲染循环。

### SOG 与原始 Gaussian 数据格式不同

项目同时拥有：

- FieryGS 可读取的 PLY 原始 Gaussian 数据；
- PlayCanvas 可读取的 SOG 压缩场景。

两套格式之间没有现成的实时深度共享接口，也没有已完成的坐标、相机和纹理互操作层。

## 6. 已评估方案

### 方案 A：MuJoCo 增加相机

不采用。MuJoCo 只负责机器人模型和运动仿真，深度来源必须是 Gaussian 场景。

### 方案 B：预渲染一张全场景深度图

不采用。深度是视点相关的，单张全局深度图无法支持第一人称相机的平移和旋转。

### 方案 C：稀疏视点深度缓存

可作为性能降级方案，但不作为主方案。它需要视点选择、重投影、补洞和遮挡处理，运动范围受限。

### 方案 D：独立 FieryGS Python sidecar

适合生成基准帧或离线数据，不适合最终实时前端。每帧进程通信会带来延迟、部署和 CUDA 环境依赖。

### 方案 E：维护 PlayCanvas GSplat Fork

当前推荐方案。保留现有 SOG 加载、相机、机器人 Overlay 和渲染生命周期，仅增加 Gaussian depth pass。

## 7. 推荐最终架构

```text
MuJoCo
  → 机器人位姿
  → RobotOverlayRuntime
  → PlayCanvas 第一视角相机

PlayCanvas 本地 GSplat Fork
  → Gaussian RGB pass
  → Gaussian depth pass（仅深度模式开启）
  → GPU 线性深度纹理

SensorPanel
  → RGB 模式显示 RGB
  → 深度模式显示 Gaussian depth texture
```

深度帧建议格式：

- 单通道线性深度。
- GPU 内部优先使用 `R32F` 或等效浮点格式。
- 低分辨率起步：320×240。
- 深度模式更新频率：15–30 FPS。
- 空值为 0，并提供有效像素比例。
- 帧携带 sequence、timestamp、width、height 和相机参数。

## 8. 后续计划

### 阶段一：基准与坐标验证

- 用 FieryGS 原始 PLY 和 `camera.json` 复现已有深度帧。
- 确认深度单位、相机坐标、裁剪面和 PlayCanvas 坐标转换。
- 对比 FieryGS RGB/深度与 PlayCanvas 视觉场景。

### 阶段二：PlayCanvas 本地 Fork

- 固定 PlayCanvas 2.21.1 版本。
- 将 GSplat 相关源码纳入项目维护范围。
- 增加 depth attachment 和 Gaussian depth shader。
- 暴露 `setDepthCaptureEnabled()` 和 `getLatestDepthFrame()`。
- 确保 depth pass 与第一视角相机共用位姿和排序结果。

### 阶段三：前端实时接入

- 深度模式开启时启用 depth pass。
- RGB 模式关闭 depth pass。
- 使用 GPU 纹理显示深度，避免同步 CPU 回读。
- 增加深度范围、无效像素和帧率状态。
- 处理暂停、重置、场景切换、窗口缩放和 context loss。

### 阶段四：质量和性能

- 处理透明 splat 深度空洞和边界噪声。
- 增加线性深度到伪彩色的 shader。
- 加入轻量时间滤波。
- 评估 320×240 与 640×360 的性能差异。
- 必要时加入隔帧复用或稀疏视点缓存作为降级模式。

## 9. 验收标准

功能验收：

- 第一视角相机随机器人平移、转向和俯仰实时变化。
- 深度图与第一视角 RGB 视场角、位姿和时间戳一致。
- 深度模式不显示其他传感器画面。
- RGB 模式不运行额外 depth pass。
- 场景切换、暂停、重置和 WebGL context 恢复后功能正常。

性能验收：

- 深度模式达到至少 15 FPS，目标 30 FPS。
- 深度帧延迟小于 100 ms。
- 不使用每帧同步 `readPixels` 作为主传输路径。
- 机器人运动时无明显画面跳变和相机漂移。

质量验收：

- 用 FieryGS 深度样本进行逐像素或区域级对照。
- 检查墙体、桌椅、门框等主要结构的深度顺序。
- 记录无效像素比例和远近裁剪范围。
- 明确区分离线基准、回放帧和实时深度帧。

## 10. 当前结论

项目的机器人第一视角相机已经实现，真实 Gaussian 深度数据也已经获得并接入前端回放。当前唯一的核心缺口是 PlayCanvas GSplat 的实时深度输出能力。

最终应采用 PlayCanvas GSplat 本地 Fork，参考 FieryGS 的深度定义和 rasterizer 逻辑，增加 GPU Gaussian depth pass。MuJoCo 不需要增加相机，预渲染全场景深度也不应作为主方案。
