# 项目总览

[返回入口](00_START_HERE.md) · [状态流](05_STATE_AND_DATA_FLOW.md) · [代码所有权](03_SOURCE_OWNERSHIP.md)

## 系统组成

- **原生 Vulkan GS 程序**：`vk_gaussian_splatting/`，负责 Vulkan Context、场景加载、GBuffer 和多个 GS 渲染管线。
- **Dear ImGui Docking UI**：所有窗口都在原生进程中绘制，中央窗口名称精确为 `Viewport`。
- **MainWorkspace**：本项目新增的监控工作区，绘制项目、场景、机器人、训练、图表、地图、日志和状态栏。
- **ApplicationState**：监控 UI 的集中状态；不拥有 Vulkan 对象或 Gaussian 数据。
- **Mock 数据源**：`MockRobotDataSource`、`MockSensorDataSource`、`MockTrainingDataSource`。
- **Training Charts**：使用项目已有 ImPlot 绘制固定容量训练历史。
- **Performance Charts**：展示实际 FPS、Profiler GPU 帧时间、CPU UI 时间；无可靠值时显示 N/A。
- **Navigation Map**：使用 `ImDrawList` 绘制的二维 Mock 可视化，不是 SLAM 地图。
- **Event Log**：内存中的固定容量事件日志，不写磁盘。
- **React UI 参考项目**：`frontend/`，只用于视觉和产品概念参考，不参与原生程序构建或运行。

## 关键边界

- GS 画面不是网页、WebView 或视频流，而是 Vulkan 写入现有 GBuffer 后，由 `ImGui::Image` 在原生 `Viewport` 中显示。
- `frontend` 不是最终运行依赖，不需要 Node 服务、浏览器或网络。
- 机器人、传感器、训练和导航数据都是 Mock，不代表真实设备或真实算法结果。
- 当前没有 ROS2、Gazebo、Isaac Sim、SLAM、Nav2、强化学习算法或 Python 训练服务。

## 总体架构

```text
main.cpp
  ├─ nvvk::Context                    [上游：Vulkan 上下文]
  ├─ nvapp::Application               [上游：窗口与帧循环]
  └─ GaussianSplattingUI              [集成接缝]
       ├─ GaussianSplatting           [上游：场景、GBuffer、渲染]
       │    └─ GBuffer Descriptor Set ──> ImGui::Begin("Viewport") 内的 ImGui::Image
       ├─ Mock*DataSource             [本项目：Mock 权威状态]
       ├─ ApplicationState            [本项目：监控状态与渲染摘要]
       └─ MainWorkspace               [本项目：Dock 面板]
            ├─ Training/Performance Charts (ImPlot)
            ├─ Navigation Map (ImDrawList, MOCK)
            └─ Event Log (RingBuffer)

frontend/                              [独立参考项目，不进入上述运行链]
```

## 所有权原则

GS 场景、Gaussian 数组、Vulkan Buffer/Image、GBuffer、Descriptor Set、管线和相机由上游类拥有。监控层只从这些对象提取轻量摘要到 `RenderStatusView`，不得把 GPU 资源复制进 `ApplicationState`。详细表见 [03_SOURCE_OWNERSHIP.md](03_SOURCE_OWNERSHIP.md)。
