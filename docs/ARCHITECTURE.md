# 系统架构

[文档索引](README.md)

## 三条运行管线

```text
React / Zustand
 ├─ 展示服务 → PlayCanvas → GS、火焰、机器人、深度/热像
 ├─ 认证与场景 adapter → Tauri Rust → SQLite / scene:// 本地资源
 │                    └→ 浏览器 Express → SQLite（仅认证）
 └─ simulationService → Tauri command / Channel
                      → Rust SimulationManager
                      → C++ Sidecar（stdin/stdout NDJSON）
                      → MuJoCo + Convex MPC
```

展示机器人的程序化步态不等于 MuJoCo 控制器输出。当前空气墙约束前端位移，局部台阶通过 pose override 演示四足 IK，均未接入后端物理碰撞。`VITE_DATA_SOURCE=mock` 只决定通用业务数据，不控制这些独立服务。

## 代码地图

| 目录/入口 | 职责 |
| --- | --- |
| `src/components/SimulationView.tsx` | 主视图、火焰/机器人工具栏 |
| `src/components/StepDemoControls.tsx` | 局部台阶样例交互 |
| `src/features/gaussian-viewer/renderer/PlayCanvasGsRuntime.ts` | 场景生命周期、相机与子系统组装 |
| `src/features/gaussian-viewer/depth/` | 实际 GS 深度捕获、解码和回读 |
| `src/features/gaussian-viewer/thermal/` | 相对热像计算与 Worker |
| `src/features/gaussian-viewer/environment/` | 火焰和氛围渲染 |
| `src/features/gaussian-viewer/robot/` | 模型、骨架、标定、碰撞与台阶覆盖层 |
| `src/services/fire-playback/` | 播放数据校验、缓存、插值、多火源管理 |
| `src/services/robot-motion-playback/` | 程序化步态、键盘运动、旧地面高度采样 |
| `src/services/robot-collision/` | 连续矩形碰撞、旋转约束、office_01 障碍盒 |
| `src/services/step-demo/` | 两级接触面、足端 IK/FK 和样例状态 |
| `src/services/auth/`, `scenes/`, `simulation/` | 运行时 adapter 与服务边界 |
| `src-tauri/src/` | 桌面认证、场景导入、Sidecar 生命周期和消息校验 |
| `native/mujoco-sidecar/` | 物理仿真、平地 MPC、协议与原生测试 |
| `vite.config.ts` | 开发资源路由和生产资产白名单 |

## 深度与火场

GS 深度来自真实渲染场景。GPU 深度纹理逐帧提供给火焰遮挡；深度面板和热像使用独立低频 CPU 回读，不把面板刷新率作为火焰遮挡刷新率。

V1 火焰是离线体积数据回放；多点火场组合桌子、沙发和窗帘的独立回放，并添加展示氛围，不是前端求解全房间火灾。V2 是另一个实验呈现路径。GS 房间和火焰数据分别加载、配准。

热像使用 V1 气体温度通道、固体温度附加帧和同步 GS 深度，由 Worker 生成相对热度图。它没有完整环境受热、材质发射率或真实热相机响应，不能标为摄氏度真值。

## 机器人与地面

机器人有 GS 整体朝向、独立标定和运动根姿态三个层次。空气墙在公共场景坐标计算，再转回运动坐标；当前水平矩形约 76 × 36 cm，随偏航和标定缩放变化。

旧高度图用于主地面，存在三点标定时由平面覆盖。局部台阶保持两级高度跳变，逐足查询目标面、求 IK 并调整机身。退出样例恢复原姿态来源和标定；未实现支撑相锁足与连续跨阶。

## 原生仿真

独立 C++ Sidecar 隔离高频物理循环与 UI。Rust 通过固定资源路径启动进程，验证 NDJSON 协议并管理生命周期。当前 MuJoCo 500 Hz、腿控制 250 Hz、MPC 50 Hz；Go2 MPC 限于平地环境。

原生实现、固定依赖和测试见 [Sidecar README](../native/mujoco-sidecar/README.md)。GS 场景与原生碰撞几何尚未自动配准。
