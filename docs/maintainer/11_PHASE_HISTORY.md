# 阶段历史

[返回入口](00_START_HERE.md) · [源码所有权](03_SOURCE_OWNERSHIP.md) · [安全修改](09_SAFE_CHANGE_GUIDE.md)

本页以当前 Git 对象为依据。当前分支名或文档名称不是 tag；仓库当前没有 Git tags。

## 基线

| 节点 | Commit | 内容 |
|---|---|---|
| 合并项目初始基线 | `92932be` | 将 `frontend/` 与 `vk_gaussian_splatting/` 统一到同一仓库历史 |
| Stage 1A（当前活动历史） | `95cb9b9` | `Integrate monitoring workspace into Gaussian splatting UI` |
| Stage 1B | `85a8f51` | `Add monitoring charts, navigation map, and event logging` |
| 1B 后续仓库卫生 | `8524a85` | 将本地 GS 场景资产排除出 Git |

当前维护分支从 `8524a85` 开始。阶段分支 `native-ui-phase1` 指向 `95cb9b9`，`native-ui-phase1b` 指向 `8524a85`。

## Stage 1A

目标：在不改写 GS 渲染核心的前提下，把四足机器人研究监控 workspace 接入原生 ImGui 应用，并建立可替换的数据边界。

新增文件：

- `src/application_state.h/.cpp`
- `src/app_actions.h`
- `src/data_sources.h`
- `src/mock_data_sources.h/.cpp`
- `src/main_workspace.h/.cpp`

修改文件：`src/main.cpp`、`src/gaussian_splatting_ui.h/.cpp`。

完成能力：

- `ApplicationState` 与 UI 子状态。
- `app_actions.h` 动作类型与 `WorkspaceCallbacks` 回调边界。
- robot、sensor、training 数据源接口和三个 mock 实现。
- `MainWorkspace`、默认 monitoring dock 和项目面板。
- Scene & Environment、Robot & Sensors、Training Monitor、Project Status、状态栏。
- Reset Monitoring Layout、MOCK 标记与输入保护。
- 在 `main.cpp` 和 `GaussianSplattingUI` 中接入，同时保留原窗口名 `Viewport`。

未完成能力：真实机器人/传感器/训练后端、ROS2、Gazebo、SLAM、路径规划和强化学习；1A 只提供 Mock 展示与接入边界。

历史说明：早期上下文中也存在对象 `8fd7d248...`，内容对应 Stage 1A 且包含额外本地场景资产历史；当前活动分支采用的等效 Stage 1A 节点是 `95cb9b9`。维护与比较应优先沿当前分支祖先链使用 `95cb9b9`，不要把 `8fd7d248...` 当 tag 或当前祖先。

## Stage 1B

目标：在 1A workspace 上增加有限容量的时间历史、训练/性能图表、导航可视化和可诊断事件日志。

新增文件：`src/ring_buffer.h`。

修改文件：`vk_gaussian_splatting/.gitignore`、`src/application_state.h`、`src/main_workspace.h/.cpp`、`src/gaussian_splatting_ui.h/.cpp`，并通过现有 CMake glob 进入构建。

`85a8f51` 在 1A 基础上完成：

- 固定容量通用 `RingBuffer`。
- Training Charts 与训练历史采样。
- Performance 面板与性能历史采样。
- Navigation Map、目标和机器人轨迹。
- Event Log 和状态转换/场景事件记录。
- 相应 state、dock、View 菜单与 workspace 更新逻辑。

后续 `8524a85` 只处理仓库卫生：在 `vk_gaussian_splatting/.gitignore` 中忽略根部本地 `flowers_1.ply`，避免大型场景误入 Git；这不是功能阶段。

Commit 与 tag：1B 功能 commit 是 `85a8f51`，阶段分支 `native-ui-phase1b` 当前位于后续卫生 commit `8524a85`。仓库没有 tag，因此不存在可报告的 1A/1B tag；不得把分支名当 tag。

## 已知验证记录

此前 Stage 1B 运行观察记录约为：窗口内容区约 `1595 × 844` 时 235–241 FPS，GPU frame 约 3.7–4.2 ms。该数据没有同条件、同场景的可靠 Stage 1A 对照，也没有完整 GPU/驱动/场景采样元数据，因此只能作为一次本地观察，不能用于正式性能结论。GPU memory 在现有 UI 中可能显示 N/A。

已知构建警告包括 MSBuild `MSB8065`；是否影响当前工具链应在下一次获准构建时重新确认。本文档任务没有运行配置、编译或程序。

## 当前能力边界

已实现的是原生 monitoring UI、模拟数据流和真实 Gaussian viewport 的集成。以下仍不应宣称完成：

- 真实四足机器人连接和控制协议。
- 真实传感器数据接入。
- 真实训练服务、模型训练或检查点管理。
- SLAM、路径规划和真实地图坐标标定。
- 持久化日志、项目数据库和多用户服务。
- 正式、可复现的性能基准体系。

## 后续阶段建议

后续阶段应先选择一个明确边界：真实数据源接入、训练后端适配、导航坐标契约或渲染/性能专项。不要同时跨越全部边界。开始前记录基线 commit、固定测试场景和验收指标，并继续通过数据源接口、动作类型与 `WorkspaceCallbacks` 隔离 UI 和后端。
