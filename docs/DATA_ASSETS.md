# 数据与资源

[返回首页](../README.md) · [文档索引](README.md)

受邀协作者无需逐目录收集文件：向维护者取得共享资产包，按 [共同开发者入口](COLLABORATOR_QUICKSTART.md) 运行 `assets:setup`。下面保留目录与手动配置说明。

## 拉取后有什么

| 资源 | 是否在 Git 中 | 用法 |
| --- | --- | --- |
| Go2 源 OBJ/XML、版本锁 | 是 | `build:go2-visuals` 生成 GLB |
| Go2 GLB | 否 | 自动生成、哈希验证，生产构建按白名单复制 |
| 运动片段、office_01 旧地面高度图 | 是 | 小型展示资源；默认运动已经改用程序化步态 |
| office_01 空气墙配置 | 是 | 37 个展示障碍盒，非完整场景重建 |
| office_01 SOG、源 PLY、语义结构 | 否 | 向数据持有者取得授权副本，或使用自己的场景 |
| 火焰和固体温度回放 | 否 | 需配套离线数据，不由 `npm ci` 生成 |
| MuJoCo/Eigen/OSQP/QDLDL 缓存 | 否 | `setup:*` 脚本下载固定版本并验证 |
| 本地账户、数据库、截图、安装包 | 否 | 各自在本机生成 |

仓库根目录可能存在独立 `FieryGS/` 求解器 checkout，但它不是本项目已声明的 submodule，也不是快速启动依赖。当前没有提供可公开下载的场景数据包地址。

## 外部火场目录

在 `.env.local` 配置（路径只供 Vite 服务和打包使用，不作为前端 `VITE_*` 变量暴露）：

```dotenv
GS_SCENE_DATA_ROOT=E:/research-data/office_01
BUNDLE_FIRE_PLAYBACK=1
```

不配置时沿用原开发目录 `D:/interiorgs_data/office_01`。修改配置后重启 Vite/Tauri。完整桌面打包要求以下四个目录齐全：

```text
office_01/
├─ scene_yup.sog                     # 桌面手动导入；不随安装包分发
├─ fire_playback/table_high/         # V1 桌子
├─ fire_playback_room/
│  ├─ sofa_high/                     # V1 沙发
│  └─ curtain_high/                  # V1 窗帘
└─ fire_playback_v2/table_high_test/  # V2 实验
```

每个播放目录包含 `metadata.json` 和它引用的 `frames_NNN.bin`，可能还有 `proxy.bin`/`proxy-smooth.bin`。三个 V1 目录还需 `thermal.json` 和它引用的 `thermal_NNN.bin`。完整打包核对温度帧 SHA-256；缺少文件时应修复数据或显式设 `BUNDLE_FIRE_PLAYBACK=0`，不要用空文件绕过校验。

Vite 开发路由分别为 `/fire-playback/`、`/fire-playback-room/`、`/fire-playback-v2/`。生产只在 Tauri 构建且未关闭火焰打包时复制这些资源。单独 `npm run build` 不含外部火焰数据。

路径可配置不等于场景自动配准：火源、空气墙、地面和台阶仍针对 office_01。把另一个房间改名为 `scene_yup` 不会得到正确的碰撞或火场位置。

## GS 与坐标

- 桌面场景库支持 `.sog`，上限 50 MiB；由 Rust 校验并复制到 app-data。
- 开发本地夹具可放到 `public/gs/local/`，该目录的 SOG 被 Git 忽略。
- InteriorGS 源坐标为 `(X, Y, Z-up)`，本场景展示使用 `(X, Z, -Y)`；GS 整体朝向和机器人独立标定还会继续应用变换。
- office_01 空气墙通过场景名匹配启用，不是通用识别器。
- 三点地面标定优先覆盖旧高度图；单平面无法表示台阶。局部样例独立于全场地面数据。

## 离线导出与实验脚本

`scripts/export-thermal-playback.py`（需 NumPy）读取已有仿真的固体温度 NPZ，写温度附加回放，不运行求解器。播放 metadata 中的源仿真路径必须在本机有效。

`scripts/export-office-collision.py`、`scripts/survey-office-step.py` 和部分 `tools/` 脚本仍使用原实验路径/外部求解器工具。运行前阅读脚本并调整路径；它们不属于新 clone 的必跑步骤。已提交的障碍配置可直接使用，重新导出会覆盖人工修改。

视觉验收脚本也有本机 Playwright 和 GS 路径依赖，见 [测试指南](TESTING.md)。`GS_SCENE_DATA_ROOT` 不会自动修改这些脚本。

## 环境变量与本地数据

| 变量 | 读取方 | 说明 |
| --- | --- | --- |
| `VITE_DATA_SOURCE` | 前端 | 默认 `mock`；仅通用业务数据，非 GS/火焰/原生服务总开关 |
| `VITE_API_BASE_URL` | 前端 | 默认 `/api` |
| `VITE_WS_URL` | 前端预留 | 不代表已接入机器人网关 |
| `GS_SCENE_DATA_ROOT` | Vite | 外部播放目录根路径 |
| `BUNDLE_FIRE_PLAYBACK` | Vite | 只有 `0` 关闭桌面火焰资产打包，默认开启 |
| `API_PORT` / `AUTH_DB_PATH` | Express 进程 | 默认 3001 / `data/auth.sqlite` |
| `NODE_ENV` | Express 进程 | production 下 Cookie 要求 HTTPS |

Vite 读取 `.env.local`；Express 当前不会自动读取该文件，要在启动前设置 PowerShell `$env:API_PORT` 等进程环境变量。改变 API 端口还需同步修改 Vite 的 `/api` 代理目标。

Web 数据库默认 `data/auth.sqlite`。桌面数据在 Tauri 的用户 app-data 目录（应用标识 `com.peilinwu.quadrupedrobotresearch`），与 Web 数据独立。`.env.local`、数据库、场景、构建缓存和 `tmp/` 不应提交。

## 许可与来源

仓库尚未选择项目自身的统一许可证，本次整理不代替所有者授予许可。第三方资源的许可保留在：

- [Go2 来源与锁定版本](../src-tauri/resources/simulation/models/unitree-go2-menagerie/SOURCE.md) 和同目录 `upstream/LICENSE`。
- [第三方库声明](../src-tauri/resources/licenses/THIRD_PARTY_NOTICES.txt) 及相邻许可证文件。
- [C++ JSON 许可证](../native/mujoco-sidecar/LICENSES/nlohmann-json-MIT.txt)。
- [运动片段 BSD-3-Clause](../public/robot-motion/solo8_walk/LICENSE.txt) 和相邻 `source-clip.json`。

外部 GS 和火灾数据需单独确认来源和分发许可；Git 忽略不代表自动取得使用权。
