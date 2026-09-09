# 快速开始

[返回首页](../README.md) · [文档索引](README.md)

## 环境

当前桌面构建目标为 Windows x64 / NSIS；其他平台的桌面构建未验证。

| 场景 | 依赖 |
| --- | --- |
| 浏览器 UI 与测试 | Git、Node.js 24（本地验证 24.15.0）、npm、支持 WebGL2 的浏览器 |
| 桌面开发与安装包 | 上述依赖 + Rust stable MSVC、Visual Studio 2022 C++ Build Tools（C++ 桌面开发、Windows SDK）、WebView2 |
| MuJoCo/MPC 开发 | 上述依赖 + CMake，首次下载锁定依赖时需网络 |
| 离线数据处理 | Python + 对应脚本依赖，按需安装；普通启动不需要 Python |

Node 20 不适用：认证服务使用 `node:sqlite`。请统一使用 Node 24，避免把 Vite 的最低版本当成整个仓库的要求。

## 1. 拉取与安装

```powershell
git clone https://github.com/PeilinWuu/Quadruped-robot-training-platform.git
cd Quadruped-robot-training-platform
npm ci
Copy-Item .env.example .env.local
```

默认 clone 得到远端默认分支。如果某个功能仍在评审分支，须由维护者提供已推送的分支名再切换；本地未推送的提交不会出现在其他人的 clone 中。

使用 `npm ci` 保持与 `package-lock.json` 一致。Go2 源 OBJ 和锁文件已提交，无需先下载大型场景或 FieryGS 求解器。

## 2. 桌面应用（推荐）

```powershell
npm run tauri -- dev
```

Tauri 自动运行 `dev:web`：生成并校验 Go2 GLB，再启动 5173 端口的 Vite。Rust 首次编译可能较慢。桌面认证由 Rust 提供，不需要启动 Express。

1. 在桌面登录页注册本地账号。
2. 进入场景库，导入有权使用的 `.sog`，选择该场景进入主视图。
3. 导入 office_01 且配置配套数据后，可加载 V1 火灾、启动多点火场、查看深度和仿真热像。
4. “加载运动”后启用键盘控制：W/S 前后、A/D 横移、Q/E 转向、Space 停止。
5. office_01 可使用“机器人碰撞”和“台阶贴地”；台阶样例只验证三种静态站姿。

启动命令不会构建或启动原生物理仿真。程序化步态展示可独立运行。

## 3. 浏览器开发（可选）

```powershell
npm run build:go2-visuals
npm run dev
```

访问 `http://localhost:5173`。`dev` 同时运行 Vite 和 `http://localhost:3001` 认证 API；它本身不会生成 GLB，因此首次需要前一条命令。也可分两个终端运行 `npm run dev:web` 和 `npm run dev:api`。

浏览器不支持原生场景库导入、持久化或 Sidecar。开发夹具见 [测试指南](TESTING.md)。不要将浏览器页面已打开当作桌面应用已启动。

## 4. 打包桌面应用

完整火场版本要求先准备 [数据目录](DATA_ASSETS.md)：

```powershell
npm run tauri -- build
```

没有外部火焰数据时，可在 `.env.local` 设置 `BUNDLE_FIRE_PLAYBACK=0` 再执行同一命令。也可只对当前 PowerShell 会话设置：

```powershell
$env:BUNDLE_FIRE_PLAYBACK = '0'
npm run tauri -- build
Remove-Item Env:BUNDLE_FIRE_PLAYBACK
```

此安装包仍有火焰 UI，但加载火焰会提示资源缺失；它适合基础 UI、场景库和机器人开发。SOG 始终由用户导入，不打包。

产物：

- 程序：`src-tauri/target/release/quadruped-robot-research.exe`
- 安装包：`src-tauri/target/release/bundle/nsis/Quadruped Robot Research_0.1.1_x64-setup.exe`（版本以 Tauri 配置为准）
- Web 构建：`npm run build`，输出到 `dist/`，默认不复制外部火焰数据。

当前默认安装包只声明许可证资源，不包含 MuJoCo Sidecar 和物理模型；不要将它称为完整物理仿真发行包。

## 5. 原生 MuJoCo/MPC 开发（可选）

在 Windows 仓库根目录：

```powershell
npm run setup:mpc
npm run build:sidecar
npm run tauri -- dev
```

构建脚本验证模型，按需下载锁定 MuJoCo，编译 C++、运行 CTest，并把 exe/DLL/模型复制到 debug 和 release 运行目录。当前主视图采用程序化运动；原生服务是独立管线，不能据此推断空气墙或台阶已进入 MuJoCo。

更多细节见 [Sidecar README](../native/mujoco-sidecar/README.md)。原生分发还需单独调整和验证 Tauri 资源打包。
