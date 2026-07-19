# 术语表

[返回入口](00_START_HERE.md) · [项目总览](01_PROJECT_OVERVIEW.md) · [文件索引](07_FILE_INDEX.md)

| 术语 | 本项目含义 |
|---|---|
| Vulkan | 跨平台显式图形 API；本项目原生 GS 渲染、资源同步和呈现的底层。SDK 位置与构建方法见 `02_BUILD_AND_RUN.md`。 |
| ApplicationState | 项目 UI 的集中展示状态；不是 Vulkan/场景资源的所有者。 |
| app_actions.h | 定义控制模式、训练命令、命令状态和 action 值类型；实际回调集合是 `WorkspaceCallbacks`。 |
| WorkspaceCallbacks | `MainWorkspace` 用来请求控制模式、训练命令和 mock reset 的回调集合，由 `GaussianSplattingUI` 注入。 |
| MainWorkspace | 项目监控面板、dock 布局、历史采样、导航和日志的实现。 |
| GaussianSplatting | 上游原生渲染核心类，负责场景和 Vulkan 渲染。 |
| GaussianSplattingUI | 继承渲染核心的集成层，连接 loader、Viewport、项目状态与 workspace。 |
| Viewport | 显示 GBuffer 渲染结果的原生 ImGui 窗口；名称必须保持为 `Viewport`。 |
| GBuffer | 渲染核心持有的图像/附件集合，Viewport 通过 descriptor 显示其结果。 |
| Descriptor Set | Vulkan 将 image、buffer 等资源绑定给 shader 的描述符集合；Viewport 使用 GBuffer 的 descriptor 显示结果，项目状态不应持有它。 |
| Gaussian Splatting | 用大量三维高斯基元合成视图的渲染方法；实现位于 `src/gaussian_splatting.*` 及 shaders。 |
| splat / Gaussian | Gaussian Splatting 场景中的点/高斯基元。 |
| PLY | 可作为场景输入的文件格式之一；可能很大，不应直接当普通文本读取。 |
| SPZ | 压缩 Gaussian Splatting 场景格式之一。 |
| VKGS | 本项目加载器支持的 Vulkan Gaussian Splatting 场景格式之一。 |
| OBJ | 常见三维网格格式；由原应用相关加载路径处理，不是 monitoring 状态格式。 |
| Dear ImGui | 即时模式图形界面库；原生菜单、Viewport 和全部监控面板都由它绘制。 |
| Dockspace | Dear ImGui 的可停靠窗口空间；默认布局由 `buildMonitoringDockLayout()` 创建。 |
| ImPlot | 基于 ImGui 的绘图库；Training/Performance 图表使用其绘图能力。 |
| snapshot | 某一时刻稳定、可复制的数据源状态，供 UI 线程读取。 |
| data source | 提供机器人、传感器或训练 snapshot/命令接口的抽象。 |
| Mock | 模拟而非真实硬件/服务的数据与行为；UI 必须明确标识。 |
| TrainingState | 当前训练状态、进度和指标的展示模型。 |
| RingBuffer | 固定容量历史缓冲；满后覆盖最旧数据，避免无界内存增长。 |
| NavigationState | 当前机器人位置、目标和轨迹的 UI 状态；当前数据为 Mock。 |
| Event Log | workspace 维护的有限容量 UI 事件记录，不是持久化系统日志。 |
| dock / DockBuilder | ImGui 窗口停靠布局及其构建 API。 |
| Reset Monitoring Layout | 恢复项目默认 dock 布局的操作。 |
| input protection | 根据 ImGui 捕获/文本输入状态阻止全局快捷键误触发。 |
| profiler | nvpro 提供的性能分析设施；项目读取可用 GPU frame 指标。 |
| RenderStatusView | `ApplicationState` 中的渲染/loader 展示摘要；不是 loader 或 GPU 资源本身。 |
| Slang | Shader 编译工具链；当前本地 SDK 为 2025.13.1，由 CMake 配置引用。 |
| CMake | 生成 Visual Studio 工程并组织依赖、源码、shader 与运行时复制的构建系统。入口是 `vk_gaussian_splatting/CMakeLists.txt`。 |
| Visual Studio 多配置生成器 | 同一 build 目录可包含 Debug/Release 等配置；构建时必须用 `--config Release`，不能只依赖 `CMAKE_BUILD_TYPE`。 |
| loader status | 场景加载器的 busy、成功、错误等面向 UI 的摘要。 |
| integration layer | 项目 UI 与上游渲染核心的连接代码，主要是 `main.cpp` 和 `gaussian_splatting_ui.*`。 |
| upstream core | 原 Gaussian Splatting/Vulkan 示例及 nvpro 框架代码，修改风险较高。 |
| generated directory | CMake/build/依赖下载/二进制产生的目录，不作为手工源码维护。 |
| Stage 1A | 当前历史中引入基础监控 workspace、state/actions、mock 数据源和面板集成的阶段。 |
| Stage 1B | 增加监控图表、导航地图、事件日志及相关历史缓冲的阶段。 |
