# 建筑室内火灾四足机器人自主搜索与避障训练系统

面向建筑火灾场景的四足机器人训练与监控桌面原型。项目使用 React 19、TypeScript、Vite 和 Tauri 2，提供场景配置、仿真监控、传感器视图、训练指标、机器人状态以及本地用户认证。

当前版本是桌面端技术基线：监控业务数据默认来自 Mock 服务；Gaussian Viewer 只完成了 Canvas/WebGL2 生命周期验证，尚未接入真实 Gaussian Splatting 渲染；MuJoCo、ROS 2 和机器人动力学也尚未接入。

## 当前能力

- 高保真火灾搜索训练监控界面与响应式布局。
- 场景、训练、机器人和传感器服务的 Mock/Real 适配边界。
- 浏览器模式下基于 Express、SQLite 和 HttpOnly Cookie 的本地认证。
- Tauri 桌面模式下基于 Rust、SQLite 和本地会话令牌的原生认证。
- 懒加载的单一 WebGL2 Canvas，包含尺寸同步、DPR 限制、暂停/恢复、context lost 和资源清理。
- Windows NSIS Release 构建配置。

以下能力目前没有实现：

- Gaussian Splatting 场景解析或真实渲染；
- SOG、PLY、SPZ 等场景导入；
- MuJoCo 仿真、Robot Overlay、ROS 2 或真实训练后端；
- 远程场景、云同步和在线转换。

## 环境要求

Web 开发至少需要：

- Node.js 20.19+ 或 22.12+
- npm

Windows 桌面开发还需要：

- Rust stable MSVC 工具链（`x86_64-pc-windows-msvc`）
- Microsoft C++ Build Tools
- WebView2 Runtime

安装 JavaScript 依赖：

```bash
npm install
```

## 启动方式

### 浏览器开发模式

```bash
npm run dev
```

该命令同时启动：

- Vite 前端：`http://localhost:5173`
- Express 认证 API：`http://localhost:3001`

首次使用时可在登录页注册账号。浏览器认证数据库位于 `data/auth.sqlite`，该目录不会提交到 Git。

也可以分别启动服务：

```bash
npm run dev:web
npm run dev:api
```

### Tauri 桌面开发模式

```bash
npm run tauri dev
```

桌面模式只通过 `beforeDevCommand` 启动 Vite，不启动 Express。认证命令由 Rust 处理，数据库写入 Tauri app-data 目录中的 `auth.sqlite`；前端会在运行时自动选择 Tauri 或 HTTP 认证适配器。

## 构建

Web production 构建：

```bash
npm run build
```

Windows Tauri Release 与 NSIS 安装包：

```bash
npm run tauri build
```

主要输出目录：

```text
dist/
src-tauri/target/release/
src-tauri/target/release/bundle/nsis/
```

## 检查与测试

前端、服务端和 Node 认证检查：

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Rust 桌面端检查：

```bash
cd src-tauri
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
cargo check
```

## 数据源配置

复制 `.env.example` 为 `.env.local`，通过 `VITE_DATA_SOURCE` 选择业务数据源：

```env
VITE_DATA_SOURCE=mock
```

- `mock`：使用内置场景、机器人、传感器和训练数据，是当前默认模式。
- `real`：进入 `src/services/real.ts` 的真实服务边界；未接入的操作会明确报告失败，不会伪造成功结果。

认证适配器不受 `VITE_DATA_SOURCE` 控制，而是根据当前是否运行在 Tauri 中自动选择。

## 目录结构

```text
src/
├─ components/                    # Dashboard 面板和仿真视图
├─ config/                        # 数据源配置
├─ features/gaussian-viewer/      # WebGL2 Viewer 生命周期基线
│  └─ renderer/                   # WebGL2 Probe 与 Runtime 工厂
├─ services/                      # 业务服务与认证适配器
│  └─ auth/                       # Tauri/HTTP 认证运行时分流
├─ store/                         # Zustand 页面状态
├─ types/                         # 领域模型
├─ App.tsx                        # 页面组合
└─ App.css                        # 工业监控界面样式

server/
├─ auth.ts                        # Web scrypt 密码与会话处理
├─ database.ts                    # Web SQLite 用户和会话表
├─ index.ts                       # Express 认证 API
└─ auth.test.ts                   # Node 认证测试

src-tauri/
├─ capabilities/default.json      # 最小桌面 capability
├─ src/auth/                      # Rust 认证模型和 SQLite 实现
├─ src/lib.rs                     # Tauri Builder 与 command 注册
├─ Cargo.toml
└─ tauri.conf.json                # 窗口、CSP 与 NSIS 配置
```

## 认证与数据边界

- 密码使用 scrypt 和随机盐保存，不存储明文。
- 浏览器会话通过 HttpOnly、SameSite Cookie 管理，数据库只保存令牌摘要。
- Tauri 会话通过 Rust command 管理，认证数据库与 Web 数据库相互独立。
- 未认证用户不能进入 Dashboard，应用启动时会尝试恢复有效会话。
- `data/`、`dist/`、`src-tauri/target/` 和本地 SQLite 产物不应提交到 Git。

## 后续集成方向

- 在 `src/features/gaussian-viewer/renderer/` 内接入真实 GS Runtime，同时保持单一 Canvas 和现有生命周期接口。
- 在 `src/services/real.ts` 实现真实场景、仿真、训练、机器人和传感器服务。
- MuJoCo 接入前先明确本地库分发、线程模型、Tauri command 边界和 Release 打包策略。
- ROS 2、WebSocket 或视频流数据应先转换为现有领域模型，再进入 store 和组件。

不要把尚未接入的渲染、仿真或训练能力标记为已完成。
