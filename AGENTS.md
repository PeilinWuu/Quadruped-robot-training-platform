# AGENTS.md

本文件适用于仓库根目录及所有子目录。自动化代理和维护者在修改前必须遵守。

## 工作区

- 唯一有效根目录：`C:\Users\Administrator\Documents\quadruped_robot_research`。
- 不访问、扫描、复制或引用任何旧工作区。
- 开始前阅读 `docs/maintainer/00_START_HERE.md`，并执行只读的 `git status --short`、`git branch --show-current`、`git rev-parse HEAD`。

## 项目边界

- `vk_gaussian_splatting/src/application_state.*`、`app_actions.h`、`data_sources.h`、`mock_data_sources.*`、`main_workspace.*`、`ring_buffer.h` 是项目监控层。
- `vk_gaussian_splatting/src/main.cpp` 和 `gaussian_splatting_ui.*` 是高风险集成层。
- 其余 Gaussian/Vulkan 核心、`nvpro_core`、`third_party` 和生成依赖默认视为上游/第三方；除非任务明确要求，不修改。
- `frontend/` 是 Web 参考实现，不是原生 CMake 运行时依赖。
- `build*`、`_bin`、`.vs`、`_deps`、SDK、DLL 和大型 PLY/SPZ 是生成物或本地资产，不手工修改、不提交。

## 当前构建与运行命令

完整前置条件见 `docs/maintainer/02_BUILD_AND_RUN.md`。以下均为 CMD 单行命令，只有用户明确授权配置、构建或运行时才执行。

```cmd
cmake -S "C:\Users\Administrator\Documents\quadruped_robot_research\vk_gaussian_splatting" -B "C:\Users\Administrator\Documents\quadruped_robot_research\vk_gaussian_splatting\build_phase1b" -G "Visual Studio 17 2022" -A x64 -DVulkan_ROOT="%VULKAN_SDK%" -DCMAKE_PREFIX_PATH="%VULKAN_SDK%" -DSlang_ROOT="C:/Users/Administrator/Documents/quadruped_robot_research/vk_gaussian_splatting/build/_deps/Slang-windows-x86_64-2025.13.1"
cmake --build "C:\Users\Administrator\Documents\quadruped_robot_research\vk_gaussian_splatting\build_phase1b" --config Release --parallel
"C:\Users\Administrator\Documents\quadruped_robot_research\vk_gaussian_splatting\_bin\Release\vk_gaussian_splatting.exe" --inputFile "C:\Users\Administrator\Documents\quadruped_robot_research\vk_gaussian_splatting\flowers_1.ply"
```

## 修改规则

- 保留原生 ImGui 窗口名 `Viewport`。
- 项目面板集中在 `MainWorkspace`；状态放入 `ApplicationState`；动作类型来自 `app_actions.h` 并通过 `WorkspaceCallbacks` 转发；后端通过 data source 接口。
- 不让 UI 面板持有 Vulkan image、descriptor、command buffer 或场景 loader 的所有权。
- Mock 数据必须保持清晰的 `MOCK` 标记，不得描述成真实硬件或真实训练。
- 新键盘快捷键必须沿用实际保护条件：`WantTextInput`、`IsAnyItemActive()` 和 `WantCaptureKeyboard`/Viewport hover；地图鼠标交互必须限制在 canvas hover 时。
- 新窗口必须有 View 菜单开关、默认 dock 位置和 Reset Monitoring Layout 恢复路径。
- CMake 使用源码 glob；新增 `.cpp` 可能需要重新配置，但仅在用户明确授权时执行。

## 安全与 Git

- 保留任务开始前已有的修改；它们默认属于用户。
- 未明确要求时，不安装依赖、不联网拉取、不配置、不编译、不运行、不切换分支、不暂存、不提交、不推送。
- 禁止 `git reset --hard`、`git clean` 和宽泛的批量恢复。不得删除 build 或资产来排错。
- 只创建任务要求的文件；不生成额外报告、临时脚本或二进制。
- 一个任务只解决一个阶段目标；发现额外问题先报告，不顺手扩展范围。
- 每次交付都报告实际验证范围、未运行项、`git status --short` 和 `git diff --stat`。

## 验证

- 文档：检查相对链接、真实路径/符号、冲突标记和 `git diff --check`。
- 源码：先静态检查声明—实现—调用链；只有任务授权时才配置、编译或运行。
- 不把“静态检查通过”写成“构建通过”，不把单次 FPS 观察写成性能保证。

完整维护说明从 `docs/maintainer/00_START_HERE.md` 开始。
