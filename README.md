# 建筑室内火灾四足机器人自主搜索与避障训练系统

面向建筑室内火灾任务的四足机器人仿真、控制与监控桌面平台。项目以 React 19、TypeScript、Vite 和 Tauri 2 构建桌面界面，以 Rust 管理本地数据与仿真进程，并通过独立 C++ Sidecar 接入 MuJoCo 和 Unitree Go2 Convex MPC 运动控制。

当前版本已经打通 **三维场景显示 → 桌面命令 → MuJoCo 物理仿真 → Go2 运动控制 → 位姿与遥测回传** 的本地闭环。项目标题中的火灾感知、自主搜索、路径规划、避障、真实训练后端和实体机器人连接仍属于后续阶段，不应将界面中的 Mock 数据视为真实实验结果。

## 当前完成度

### 已真实实现

- React/Tauri 桌面监控界面、响应式布局和本地用户认证。
- 浏览器模式下基于 Express、SQLite、scrypt 和 HttpOnly Cookie 的认证。
- Tauri 模式下基于 Rust、SQLite 和本地会话令牌的原生认证。
- PlayCanvas Gaussian Splatting Runtime，可在桌面端导入、校验、持久化和渲染本地 `.sog` 场景。
- 场景库管理、场景方向持久化、相机轨道控制、资源取消加载和 WebGL context 恢复。
- Unitree Go2 Menagerie 模型及官方网格资产的本地可视化。
- 独立 C++17 MuJoCo Sidecar，由 Tauri/Rust 受控启动、通信、停止和异常清理。
- MuJoCo 3.11.0 固定步长物理仿真，支持模型加载、启动、暂停、单步、重置、停止和 0.25～4 倍速。
- 机器人根位姿、12 个关节、足端接触、碰撞、控制状态和性能遥测回传。
- PlayCanvas Robot Overlay、位姿插值、模型切换和跟随视角。
- Go2 平地 Convex MPC：支持前进、后退、原地转向、弧线运动和受控停止。
- 基于 OSQP 的地面反力二次规划、对角小跑步态、落足点规划、摆动轨迹和腿部控制。
- 跌倒、越界、非足部接触、QP 连续失败、非有限控制量和持续执行器饱和保护。
- Windows NSIS Release 构建及固定版本第三方依赖校验。

### 仍为 Mock 或界面预留

- 火灾环境参数和温度、烟雾、CO、氧浓度等传感器数据。
- RGB、深度、热成像、LiDAR 和第一人称视频流。
- 训练任务、奖励曲线、成功率和损失曲线。
- 场景业务数据、机器人业务状态和部分控制面板。
- 添加目标、禁区、路径、标记点和距离测量等交互。

### 尚未实现

- 火灾或烟雾传播物理模型。
- SLAM、定位、建图、人员/火源识别和风险感知。
- 自主搜索、全局路径规划、局部避障和任务决策。
- 强化学习或其他真实训练后端。
- ROS 2、WebSocket 实时网关和实体 Unitree Go2 连接。
- Gaussian Splatting 视觉场景与 MuJoCo 碰撞几何的自动配准。
- 复杂地形、外力扰动、传感器噪声和 Sim-to-Real 验证。

## 系统架构

```text
React / TypeScript / Zustand / PlayCanvas
  操作界面、场景渲染、Robot Overlay、状态与图表
                         │ Tauri command / Channel
                         ▼
Tauri 2 / Rust
  本地认证、场景数据库、资源协议、Sidecar 生命周期和协议校验
                         │ stdin/stdout NDJSON
                         ▼
C++17 Simulation Sidecar
  模型加载、仿真循环、碰撞、遥测、控制器调度和故障保护
                         │
                         ▼
MuJoCo 3.11.0 + Eigen 3.4.0 + OSQP 1.0.0 + QDLDL 0.1.8
  500 Hz 物理、250 Hz 腿控制、50 Hz Convex MPC
```

一条运动指令的主要路径：

```text
SimulationView
→ Zustand store
→ ManagedSimulationService
→ Tauri simulation adapter
→ Rust SimulationManager
→ C++ NDJSON protocol
→ Go2ConvexMpcController
→ MuJoCo
→ pose / telemetry / collision events
→ PlayCanvas 和状态面板
```

将仿真放在独立 Sidecar 中，可以隔离 UI 与高频物理循环；Rust 只允许启动和访问固定资源，前端不能执行任意本地程序。

## Convex MPC 基线

当前控制器仅用于 `unitree-go2-menagerie` + `flat-ground-v1` 的 MuJoCo 仿真，不代表已经接入实体 Go2。

- MuJoCo 时间步：`0.002 s`，即 500 Hz。
- 腿控制频率：250 Hz。
- MPC 频率：50 Hz。
- 预测节点：10，节点间隔 `0.02 s`，预测时域 `0.2 s`。
- 摩擦系数：0.8。
- 单足最大法向力：120 N。
- 单次求解预算：15 ms。
- 前向速度范围：`-0.20～0.30 m/s`。
- 偏航角速度范围：`-0.50～0.50 rad/s`。
- 横向速度当前固定为 0。

控制链包括 MuJoCo 状态读取、步态生成、参考平滑、落足点规划、质心动力学 MPC、OSQP 求解、摆动足轨迹和关节级控制。控制器在故障时进入安全状态，不会把未执行的指令标记为成功。

## 环境要求

### Web 开发

- Node.js 20.19+ 或 22.12+
- npm

### Windows 桌面开发与 MuJoCo

- Windows x64
- Rust stable MSVC 工具链（`x86_64-pc-windows-msvc`）
- Microsoft Visual Studio 2022 C++ Build Tools
- CMake
- WebView2 Runtime
- 首次准备固定版本依赖时可访问相应官方发布地址

安装 JavaScript 依赖：

```bash
npm install
```

首次构建 MPC Sidecar 前准备固定版本的 Eigen、OSQP 和 QDLDL：

```bash
npm run setup:mpc
```

`npm run build:sidecar` 会在本地缓存不存在时下载锁定的 MuJoCo 3.11.0，校验文件大小与 SHA-256，然后配置 CMake、编译 Release Sidecar 并运行 C++ 测试。下载缓存和构建产物不会提交到 Git。

如需重新获取上游 Go2 Menagerie 源文件：

```bash
npm run setup:go2
npm run verify:go2
```

正式 Go2 源文件及锁文件已经提交到仓库，通常不需要重复获取。

## 启动方式

### 浏览器开发模式

```bash
npm run dev
```

该命令同时启动：

- Vite 前端：`http://localhost:5173`
- Express 认证 API：`http://localhost:3001`

首次使用时可在登录页注册账号。浏览器认证数据库默认位于 `data/auth.sqlite`。

浏览器模式可用于 UI、认证和 Mock 业务数据开发，但 **不启动 Tauri、MuJoCo Sidecar、本地 SOG 场景库或桌面仿真**。这些功能会明确显示为仅桌面版或不可用。

也可以分别启动：

```bash
npm run dev:web
npm run dev:api
```

### Tauri 桌面开发模式

首次运行前先完成 `npm install` 和 `npm run setup:mpc`，然后执行：

```bash
npm run tauri dev
```

Tauri 的 `beforeDevCommand` 会自动：

1. 验证 Go2 Menagerie 资源；
2. 构建并测试 C++ Sidecar；
3. 复制 Sidecar、MuJoCo DLL、模型和许可证到运行目录；
4. 生成并验证 Go2 可视资产；
5. 启动 Vite 前端。

桌面模式不需要 Express 认证 API。认证、场景数据库与仿真命令由 Rust 处理，数据写入 Tauri app-data 目录。

## 构建

Web production 构建：

```bash
npm run build
```

只构建和测试 C++ MuJoCo Sidecar：

```bash
npm run build:sidecar
```

Windows Tauri Release 与 NSIS 安装包：

```bash
npm run tauri build
```

主要输出目录：

```text
dist/
native/mujoco-sidecar/build/Release/
src-tauri/target/release/
src-tauri/target/release/bundle/nsis/
```

## 检查与测试

前端、Node 服务和资源检查：

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

C++ Sidecar 的配置、编译和 CTest：

```bash
npm run build:sidecar
```

该测试集覆盖协议、模型加载、确定性仿真、进程生命周期、MPC 数学核心、20 秒步态集成，以及前进、后退、左右转向、左右弧线和停止验收。

Rust 桌面端检查：

```bash
cd src-tauri
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
cargo check
```

截至 2026-08-06，本地验证结果为：

- Node/资源/认证测试：7/7 通过；
- 前端测试：98/98 通过；
- C++ 协议检查：139 项通过；
- MPC 核心检查：56 项通过；
- 20 秒步态集成检查：3031 项通过；
- MPC 运动验收检查：163 项通过；
- TypeScript 类型检查通过。

这些结果是确定性 MuJoCo 仿真验证，不代表实体机器人或真实火灾环境性能。

## 数据源与运行时边界

复制 `.env.example` 为 `.env.local`，通过 `VITE_DATA_SOURCE` 选择通用业务数据源：

```env
VITE_DATA_SOURCE=mock
```

- `mock`：使用内置场景、训练、机器人和传感器业务数据，是当前默认模式。
- `real`：进入 `src/services/real.ts` 的真实业务边界；未接入的操作会明确失败。

需要注意：

- 认证适配器根据浏览器/Tauri 运行时自动选择，不受 `VITE_DATA_SOURCE` 控制。
- MuJoCo 仿真由独立 `simulationService` 管理，不是 Mock 服务；它只在 Tauri 桌面模式可用。
- SOG 场景库使用独立的 Tauri Scene Adapter，也不等同于旧的通用 `SceneService` Mock 数据。
- 环境传感器和训练指标目前仍来自 Mock。

## 目录结构

```text
src/
├─ components/                         # Dashboard、仿真和状态面板
├─ config/                             # 通用数据源配置
├─ features/gaussian-viewer/
│  ├─ renderer/                        # PlayCanvas GSplat Runtime 和相机
│  ├─ robot/                           # Go2/最小四足 Robot Overlay
│  └─ environment/                     # 可视环境覆盖层
├─ services/
│  ├─ auth/                            # Tauri/HTTP 认证运行时分流
│  ├─ scenes/                          # 桌面 SOG 场景库适配器
│  └─ simulation/                      # 仿真服务、Tauri adapter 和遥测缓冲
├─ store/                              # Zustand 页面与仿真状态
├─ types/                              # 业务领域模型
├─ App.tsx
└─ App.css

server/                                # 浏览器开发模式认证 API

src-tauri/
├─ resources/simulation/               # 固定 MuJoCo 模型与环境
├─ src/auth/                           # Rust SQLite 认证
├─ src/scenes/                         # SOG 导入、数据库和 scene:// 协议
├─ src/simulation/                     # Sidecar 管理、协议和 Tauri commands
├─ src/lib.rs                          # Tauri Builder 与 command 注册
└─ tauri.conf.json

native/mujoco-sidecar/
├─ src/controllers/mpc/                # Convex MPC、步态、落足与腿控制
├─ src/simulation.cpp                  # MuJoCo 仿真与控制循环
├─ src/protocol.cpp                    # NDJSON 协议
├─ tests/                              # 协议、MPC、集成与验收测试
├─ CMakeLists.txt
└─ README.md

scripts/                               # 固定依赖获取、验证和构建脚本
```

## 安全、数据与资源边界

- 密码使用 scrypt 和随机盐保存，不存储明文。
- 浏览器会话使用 HttpOnly、SameSite Cookie，数据库只保存令牌摘要。
- Tauri 会话由 Rust command 管理，Web 与桌面认证数据库互相独立。
- SOG 导入采用受控复制、格式校验、哈希记录和固定 `scene://` 读取协议。
- Sidecar 只能从固定资源目录启动，协议限制消息大小并校验类型和范围。
- 高频 pose/telemetry 使用有界、最新值优先的传递方式，避免 UI 反压阻塞物理线程。
- 应保持 `data/`、`.cache/`、`dist/`、构建目录、本地 SQLite 和导入场景不进入 Git。
- 所有第三方资源版本、来源、哈希和许可证由锁文件及 `src-tauri/resources/licenses/` 记录。

## 已知限制与后续方向

建议按以下顺序推进到项目标题所描述的完整能力：

1. 建立与 MuJoCo 一致的可碰撞场景几何，并解决 SOG 视觉场景与物理坐标配准。
2. 接入真实或仿真的 RGB-D、热成像、LiDAR 和火灾环境观测。
3. 构建最小自主闭环：定位/地图 → 目标选择 → 全局规划 → 局部避障 → 速度目标 → 现有 MPC。
4. 将温度、烟雾、结构风险和可见度纳入搜索与路径代价。
5. 建立覆盖率、搜索成功率、碰撞率、耗时、路径长度、能耗和稳定性评价体系。
6. 增加坡地、台阶、低摩擦、外力扰动、传感器噪声和模型随机化测试。
7. 在完成状态估计、安全急停、权限和通信超时策略后，再接入 ROS 2 与实体 Go2。

开发和汇报时请始终区分：**已实现功能、仿真验证结果、Mock 展示数据和未来设计接口**。
