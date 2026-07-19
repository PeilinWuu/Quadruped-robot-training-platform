# 源码来源与所有权

[返回入口](00_START_HERE.md) · [文件索引](07_FILE_INDEX.md) · [安全修改](09_SAFE_CHANGE_GUIDE.md)

判断依据是 `92932be..HEAD` 的实际 Git 差异：阶段 1A/1B 新增监控文件，并只在少量上游文件中建立集成接缝。

## Git 证据

- 当前 `origin`：`https://github.com/PeilinWuu/Quadruped-robot-training-platform.git`。
- 统一项目基线：`92932be`。
- 当前历史中的 Stage 1A：`95cb9b9`；新增项目监控文件，修改 `main.cpp` 与 `gaussian_splatting_ui.*`。
- Stage 1B 功能提交：`85a8f51`；新增 `ring_buffer.h`，修改 state/workspace/UI 接入和 `.gitignore`。
- 后续卫生提交：`8524a85`；忽略本地 `flowers_1.ply`。
- 当前历史没有保存可直接验证的 NVIDIA upstream commit/tag 映射；“上游”判断还依据基线文件的版权头、目录结构和 `92932be..HEAD` 未被项目阶段改动的范围，不能据此宣称精确上游版本。

| 路径 | 来源 | 当前职责 | 修改风险 | 推荐修改方式 |
|---|---|---|---|---|
| `src/gaussian_splatting.*` | 上游 GS 核心 | 场景、Gaussian、GBuffer、管线、Vulkan 渲染 | 高；原则上禁止 | 先阅读 NVIDIA 文档，独立任务、专项审查和性能回归 |
| `src/ply_loader_async.*`、`splat_set*`、`splat_sorter_async*` | 上游 GS 核心 | PLY/SPZ 数据与排序上传 | 高；原则上禁止 | 不与 UI 任务混改 |
| `shaders/` | 上游 Shader | GS 光栅、光追、混合和后处理 | 极高；原则上禁止 | Shader 专项分支和 GPU 验证 |
| `nvpro_core2/` | 上游框架/第三方 | `nvapp`、Vulkan 封装、ImGui/ImPlot、相机、Profiler | 极高；原则上禁止 | 优先在本项目适配层解决；不要直接修框架 |
| `3rdparty/` | 第三方 | SPZ、miniply、VRDX | 极高；原则上禁止 | 只按上游升级流程修改 |
| `src/application_state.*` | 本项目新增 | 监控状态、历史、地图、日志和渲染摘要 | 中；可经常修改 | 增量字段，保持无 Vulkan/ImGui 资源所有权 |
| `src/app_actions.h` | 本项目新增 | `ControlMode`、`TrainingCommand`、`CommandStatus` 及两个 action 值类型 | 低到中 | 保持轻量，不在 action 值对象中执行逻辑 |
| `src/data_sources.h` | 本项目新增 | 机器人、传感器、训练数据源接口 | 中 | 接 ROS2 前先扩展适配器，不破坏现有 Mock |
| `src/mock_data_sources.*` | 本项目新增 | 确定性 Mock 权威状态 | 低到中；可经常修改 | 保持更新频率、状态机和 MOCK 标记 |
| `src/main_workspace.*` | 本项目新增 | Dock、监控面板、图表、地图、日志、状态栏 | 中；可修改但需运行验证 | 一次只改一个面板或一种状态流 |
| `src/ring_buffer.h` | 本项目新增 | 固定容量历史容器 | 中 | 保持 O(1) push、时间顺序和越界保护 |
| `src/main.cpp` | 集成接缝（上游文件已修改） | Element 注册和默认 Dock 回调 | 中高；修改前审查 | 只做组装，不放业务逻辑 |
| `src/gaussian_splatting_ui.*` | 集成接缝（上游文件已修改） | GS 生命周期与监控层连接 | 高；修改前审查 | 最小补丁，保留 `GaussianSplatting::*` 委托 |
| `CMakeLists.txt` | 上游构建入口 | 源文件、Shader、依赖和运行时复制 | 高；修改前审查 | 不重复登记 GLOB 源，不引入新依赖 |
| `.gitignore` | 集成/仓库配置 | 忽略构建目录和本地场景 | 低 | 精确新增规则，避免过宽通配符 |
| `frontend/` | 本仓库参考项目 | React 视觉参考和独立服务原型 | 与原生运行隔离 | 原生 UI 任务不要修改；不是部署依赖 |
| `build/` | 旧生成物/缓存 | 旧工程、Slang SDK、1A 记录 | 不应提交；禁止清理 | 只读保留，复用 `_deps` |
| `build_phase1b/` | 当前生成物 | 当前 CMake/VS 工程和对象文件 | 自动生成，不应提交 | 用 CMake 更新，不手改 `.vcxproj` |
| `_bin/` | 构建产物 | Release EXE、DLL、INI、日志 | 自动生成，不应提交 | 由构建复制生成，不手改二进制 |
| `flowers_1.ply` | 本地场景资源 | 人工运行验证 | 大文件、被忽略 | 不提交、不删除、不读入 Git diff |

## 三类核心代码

### A. 上游 GS 核心

包括 `GaussianSplatting`、Vulkan 资源、GBuffer、加载器、CameraManipulator、Shader、`nvpro_core2`、Assets、Properties、Export Preview 和 Profiler。其历史主要来自统一仓库基线 `92932be` 及 NVIDIA 源码版权头。

### B. 本项目新增

`application_state.*`、`app_actions.h`、`data_sources.h`、`mock_data_sources.*`、`main_workspace.*`、`ring_buffer.h`。这些文件由阶段 1A/1B 提交新增。

### C. 集成接缝

- `main.cpp`：`appInfo.dockSetup` 改为 `buildMonitoringDockLayout()`。
- `gaussian_splatting_ui.h/.cpp`：加入 `ApplicationState`、MainWorkspace、Mock 数据源、状态同步和菜单开关。
- `.gitignore`：忽略 `build_phase1b/` 和本地 `flowers_1.ply`。

接缝最容易同时影响上游与本项目，修改风险高于纯面板代码。
