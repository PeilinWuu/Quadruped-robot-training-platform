# 维护者入口

这是四足机器人火灾场景原生监控程序的维护入口。程序主体是 NVIDIA Vulkan Gaussian Splatting（GS，高斯泼溅）示例，本项目在其原生 Dear ImGui 界面中加入了 Mock 机器人、传感器、训练、二维地图、图表和事件日志。

## 当前状态

已经实现：PLY/SPZ/VKGS/OBJ 加载、原生 `Viewport` 实时 GS 渲染、相机交互、Assets、Properties、Export Preview、Profiler，以及阶段 1A/1B 监控面板。

仍是 Mock：机器人、传感器、训练指标、训练状态机、导航地图、路径、目标点、障碍物、火灾风险区。性能面板中的 FPS、Profiler GPU 帧时间和 CPU UI 时间来自程序实际测量；GPU Memory 没有可靠数据时显示 N/A。

尚未实现：ROS2、Gazebo、Isaac Sim、SLAM、Nav2、真实机器人和传感器、强化学习服务、路径规划、碰撞检测、GS 重建和网络通信。

## 10 分钟快速启动

1. 打开 CMD，进入当前工作区：

   ```cmd
   cd /d C:\Users\Administrator\Documents\quadruped_robot_research
   ```

2. 检查 Vulkan SDK：

   ```cmd
   echo %VULKAN_SDK%
   dir "%VULKAN_SDK%\Include\vulkan\vulkan.h" "%VULKAN_SDK%\Lib\vulkan-1.lib" "%VULKAN_SDK%\Bin\glslangValidator.exe"
   ```

3. 首次配置 `build_phase1b`（已有正确 Cache 时跳过）：参见 [02_BUILD_AND_RUN.md](02_BUILD_AND_RUN.md)。
4. 构建 Release：

   ```cmd
   cmake --build "C:\Users\Administrator\Documents\quadruped_robot_research\vk_gaussian_splatting\build_phase1b" --config Release --parallel
   ```

5. 启动场景：

   ```cmd
   "C:\Users\Administrator\Documents\quadruped_robot_research\vk_gaussian_splatting\_bin\Release\vk_gaussian_splatting.exe" --inputFile "C:\Users\Administrator\Documents\quadruped_robot_research\vk_gaussian_splatting\flowers_1.ply"
   ```

6. 看到状态栏 `Load: READY` 和花束 GS 后，检查 View 菜单、底部图表、地图和日志。

## 推荐阅读顺序

1. `vk_gaussian_splatting/src/main.cpp`：看进程入口、Vulkan Context、Element 注册和主循环。
2. `gaussian_splatting_ui.h`：看上游 GS 与本项目监控成员在哪里汇合。
3. `gaussian_splatting_ui.cpp`：看生命周期、每帧同步、场景摘要和 UI 接入。
4. `main_workspace.h`：先掌握 MainWorkspace 的小型公共接口。
5. `main_workspace.cpp`：再看 Dock、面板、图表、地图和日志。
6. `application_state.h`：理解 UI 可以读取和修改的状态边界。
7. `data_sources.h`：理解未来真实数据源需要实现的接口。
8. `mock_data_sources.cpp`：理解当前确定性 Mock 更新与训练状态机。
9. `ring_buffer.h`：理解历史数据为何不会无限增长。
10. `gaussian_splatting.h/.cpp`：最后进入上游渲染核心，避免一开始被 Vulkan 细节淹没。

## 最重要的五个源文件

- `vk_gaussian_splatting/src/main.cpp`：启动和 Element 组装。
- `vk_gaussian_splatting/src/gaussian_splatting_ui.cpp`：最关键的集成接缝。
- `vk_gaussian_splatting/src/main_workspace.cpp`：监控 UI 行为。
- `vk_gaussian_splatting/src/application_state.h`：监控状态模型。
- `vk_gaussian_splatting/src/gaussian_splatting.cpp`：GS 核心所有权和渲染流程，仅在理解上游后修改。

## 不要随意修改

- `vk_gaussian_splatting/shaders/`
- `vk_gaussian_splatting/nvpro_core2/`
- `vk_gaussian_splatting/3rdparty/`
- `vk_gaussian_splatting/src/gaussian_splatting.*`
- `vk_gaussian_splatting/src/ply_loader_async.*`
- `build/`、`build_phase1b/`、`_bin/`（生成物或依赖缓存）
- `frontend/`（参考项目，不是原生程序运行依赖）

## 一次修改的推荐流程

先读 [09_SAFE_CHANGE_GUIDE.md](09_SAFE_CHANGE_GUIDE.md)，然后：确认 Git 状态 → 新建阶段分支 → 写单一目标 → 只读定位 → 列出文件 → 小步修改 → 每步构建 → 人工运行 → 查看 diff → 经确认后提交。

## 回滚方式

未提交修改先用 `git diff` 确认范围。只回滚自己明确修改的文件，可使用：

```cmd
git restore -- "明确的文件路径"
```

不要使用 `git reset --hard`、`git clean` 或对整个仓库执行 `git restore .`。如果修改已经提交，优先新建反向提交；不要改写共享历史。

## 全部维护文档

- [01_PROJECT_OVERVIEW.md](01_PROJECT_OVERVIEW.md)
- [02_BUILD_AND_RUN.md](02_BUILD_AND_RUN.md)
- [03_SOURCE_OWNERSHIP.md](03_SOURCE_OWNERSHIP.md)
- [04_STARTUP_AND_FRAME_FLOW.md](04_STARTUP_AND_FRAME_FLOW.md)
- [05_STATE_AND_DATA_FLOW.md](05_STATE_AND_DATA_FLOW.md)
- [06_UI_PANEL_MAP.md](06_UI_PANEL_MAP.md)
- [07_FILE_INDEX.md](07_FILE_INDEX.md)
- [08_DEBUGGING_GUIDE.md](08_DEBUGGING_GUIDE.md)
- [09_SAFE_CHANGE_GUIDE.md](09_SAFE_CHANGE_GUIDE.md)
- [10_GLOSSARY.md](10_GLOSSARY.md)
- [11_PHASE_HISTORY.md](11_PHASE_HISTORY.md)
