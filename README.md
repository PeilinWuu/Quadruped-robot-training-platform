# 建筑火灾四足机器人训练平台

基于 **React / TypeScript / Tauri / PlayCanvas** 的研究型桌面应用，用于室内 Gaussian Splatting（GS）场景浏览、火场回放、深度与相对热像展示，以及 Go2 机器人运动和局部碰撞交互。仓库另含 MuJoCo + Convex MPC 原生仿真模块。

当前重点是主界面的火场观感与机器人展示。前端火焰、热像和空气墙不能直接作为机器人训练真值；真实训练数据管线属于下一阶段。

[快速开始](docs/GETTING_STARTED.md) · [数据准备](docs/DATA_ASSETS.md) · [开发贡献](CONTRIBUTING.md) · [架构](docs/ARCHITECTURE.md) · [全部文档](docs/README.md)

**受邀共同开发者请先看 [完整展示上手入口](docs/COLLABORATOR_QUICKSTART.md)**：从 [夸克网盘](https://pan.quark.cn/s/4a16f7a62ef6) 下载共享资产包，执行 `npm run assets:setup -- <本地资产包路径>`，即可校验并配置全部展示数据。

## 快速启动桌面应用

Windows x64，安装 Node.js 24、Rust MSVC 工具链、Visual Studio 2022 C++ Build Tools 和 WebView2 后，在 PowerShell 执行：

```powershell
git clone https://github.com/PeilinWuu/Quadruped-robot-training-platform.git
cd Quadruped-robot-training-platform
npm ci
npm run tauri -- dev
```

这会打开桌面窗口，并自动生成 Go2 可视模型、启动 Vite。首次使用自行注册本地账号；桌面账号与浏览器账号独立。通过场景库导入自己的 `.sog` 文件（不超过 50 MiB）。

**仓库不含 office_01 GS 场景和火焰回放数据，也不自动下载它们。** 没有这些数据仍可启动应用、开发 UI；完整火场演示需要另行准备[外部数据](docs/DATA_ASSETS.md)。当前桌面启动不会自动构建 MuJoCo。

仅开发浏览器 UI：

```powershell
npm run build:go2-visuals
npm run dev
```

打开 `http://localhost:5173`。浏览器模式启动 Express 认证 API，但不支持桌面场景库导入和原生仿真。

## 当前能力与边界

| 模块 | 当前状态 |
| --- | --- |
| GS 场景 | 本地 SOG 导入、持久化、朝向调整、相机交互 |
| 火场 | FieryGS 离线结果回放；V1 桌子/沙发/窗帘多点展示，V2 为可选实验 |
| 遮挡与深度 | 实际 GS 深度捕获，GPU 逐帧火焰遮挡；面板低频回读 |
| 热像 | V1 气体/固体仿真温度生成相对热像；不是摄氏度或标定热相机输出 |
| 展示机器人 | 官方 Go2 网格、程序化步态、WASD/QE、office_01 矩形空气墙 |
| 台阶 | 卡座入口局部四足站立 IK 样例；未实现连续跨阶行走 |
| 原生仿真 | 独立 C++ MuJoCo + 平地 Convex MPC；需单独准备和构建 |
| 业务面板 | 部分场景、环境指标和训练曲线仍为 Mock；右侧 Mock RGB/LiDAR 已移除 |
| 后续工作 | 训练数据、自主搜索、真实传感器、ROS 2/实体机器人、GS 与物理碰撞配准 |

主视口第一人称相机仍保留。它与已移除的 Mock 第一人称传感器板块是不同功能。

## 文档导航

| 想做什么 | 文档 |
| --- | --- |
| 拉取、安装、启动或打包 | [快速开始](docs/GETTING_STARTED.md) |
| 准备 GS、火焰、热像与机器人资产 | [数据与资源](docs/DATA_ASSETS.md) |
| 理解服务、渲染和原生模块 | [系统架构](docs/ARCHITECTURE.md) |
| 修改代码、测试、提交 PR | [贡献指南](CONTRIBUTING.md) |
| 人工验收 | [测试与验收](docs/TESTING.md) |
| 排查启动、文件锁、资源缺失 | [故障排查](docs/TROUBLESHOOTING.md) |
| 查看已知限制与研究方向 | [路线图](docs/ROADMAP.md) |
| 查阅专项设计、历史审计 | [文档索引](docs/README.md) |

## 目录

```text
src/                       React UI、服务、GS/火焰/深度/机器人渲染
server/                    浏览器认证 API 与 SQLite
src-tauri/                 Rust 桌面入口、认证、场景库、仿真管理
native/mujoco-sidecar/      C++ MuJoCo 与 MPC、原生测试
public/                    已纳入版本控制的小型资源；生成模型被忽略
scripts/                   依赖准备、资源导出、构建与专项验收
tools/                     实验页面和离线转换工具
docs/                      使用、开发、架构与专题文档
.github/                   CI、Issue 与 PR 模板
```

## 许可与贡献

欢迎通过 Issue 描述问题、通过 PR 提交改动，流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。仓库当前没有声明项目自身的统一开源许可证；不要将公开可访问等同于已获得任意再分发授权。第三方模型、运动片段和库各自遵循其许可证，位置见[资源与许可说明](docs/DATA_ASSETS.md#许可与来源)。
