# 核心文件索引

[返回入口](00_START_HERE.md) · [源码所有权](03_SOURCE_OWNERSHIP.md) · [安全修改](09_SAFE_CHANGE_GUIDE.md)

本页按维护价值列出关键文件。路径均相对于仓库根目录 `C:\Users\Administrator\Documents\quadruped_robot_research`。

| 文件 | 主要符号/职责 | 直接调用关系 | 修改风险 | 阅读优先级 |
|---|---|---|---|---|
| `vk_gaussian_splatting/src/main.cpp` | `main()`；参数、Vulkan context、应用和 elements 装配 | 创建 `GaussianSplattingUI`；调用 `buildMonitoringDockLayout` | 高：启动失败或 element 顺序变化 | 1 |
| `vk_gaussian_splatting/src/gaussian_splatting_ui.h` | 集成层类声明、数据源、workspace、导出预览成员 | 继承 `GaussianSplatting`；持有 `MainWorkspace` | 高：生命周期和所有权 | 2 |
| `vk_gaussian_splatting/src/gaussian_splatting_ui.cpp` | attach/detach、菜单、文件拖放、逐帧同步、Viewport/Assets/Properties | 调用核心渲染、mock、workspace、loader | 很高：项目层与上游核心交界 | 3 |
| `vk_gaussian_splatting/src/application_state.h` | 全部展示状态、history、navigation、log、UI 开关 | 被 UI、workspace、数据源 snapshot 使用 | 中：字段变化影响多个面板 | 4 |
| `vk_gaussian_splatting/src/application_state.cpp` | 状态辅助函数/字符串转换等实现 | 服务 `ApplicationState` 展示 | 低到中 | 8 |
| `vk_gaussian_splatting/src/app_actions.h` | `ControlMode`、`TrainingCommand`、`CommandStatus` 和 action 值类型 | `WorkspaceCallbacks`/数据源使用；自身不保存回调 | 中：命令契约 | 5 |
| `vk_gaussian_splatting/src/data_sources.h` | `IRobotDataSource`、`ISensorDataSource`、`ITrainingDataSource` | UI 依赖接口；mock 实现接口 | 中：未来真实后端契约 | 6 |
| `vk_gaussian_splatting/src/mock_data_sources.h` | 三个 mock 类声明 | 实现数据源接口 | 低到中 | 9 |
| `vk_gaussian_splatting/src/mock_data_sources.cpp` | 定时更新、确定性遥测、训练状态机与请求 | UI 每帧 update/snapshot | 中：演示行为和状态转换 | 10 |
| `vk_gaussian_splatting/src/main_workspace.h` | workspace 生命周期、panel 和 history 接口 | 被 `GaussianSplattingUI` 持有 | 中 | 7 |
| `vk_gaussian_splatting/src/main_workspace.cpp` | dock builder、全部监控面板、状态栏、采样与日志 | 读取 state；调用 actions | 中到高：UI 布局和行为集中 | 11 |
| `vk_gaussian_splatting/src/ring_buffer.h` | 固定容量 `RingBuffer<T, Capacity>` | training/performance/navigation/log 使用 | 中：错误会影响所有历史数据 | 12 |
| `vk_gaussian_splatting/src/gaussian_splatting.h/.cpp` | 上游 Gaussian Splatting 核心、GBuffer、场景与 render pass | 被 UI 子类委托调用 | 很高：Vulkan/GPU 核心 | 按需 |
| `vk_gaussian_splatting/CMakeLists.txt` | C++20、源码/着色器收集、依赖和可执行目标 | CMake 配置入口 | 高：影响所有构建 | 按需 |
| `vk_gaussian_splatting/.gitignore` | 本地 build、`_bin`、本地场景资产忽略规则 | Git 工作树 | 中：可能误纳入二进制 | 按需 |
| `frontend/` | React/Web 版产品原型和交互参考 | 不被 native CMake 链接 | 低（对 native）；需独立维护 | 参考 |

## 快速定位问题

- 启动/窗口装配：先看 `main.cpp`。
- Viewport、loader、菜单或核心集成：先看 `gaussian_splatting_ui.cpp`。
- 项目面板和布局：先看 `main_workspace.cpp`。
- 数值从哪里来：依次看 `application_state.h`、`data_sources.h`、`mock_data_sources.cpp`。
- 历史曲线丢点/顺序错误：看 `ring_buffer.h` 和 `MainWorkspace::update()`。
- Vulkan/场景渲染错误：确认不是项目 UI 问题后，再进入 `gaussian_splatting.cpp` 及上游库。

## 修改前的最小调用链检查

1. 搜索符号的声明、实现和所有调用点。
2. 判断它属于上游核心、项目层还是集成层。
3. 检查状态的权威来源，避免复制第二份可写状态。
4. 若添加 `.cpp`，注意 CMake 使用 `file(GLOB ...)`：已有 build 目录可能需要重新配置才能发现新文件；是否允许配置必须由当前任务明确授权。
5. 修改窗口名时检查 dock builder、View 菜单和任何依赖该名称的 element；`Viewport` 明确禁止改名。
