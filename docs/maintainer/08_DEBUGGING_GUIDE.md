# 调试指南

[返回入口](00_START_HERE.md) · [构建与运行](02_BUILD_AND_RUN.md) · [安全修改](09_SAFE_CHANGE_GUIDE.md)

本文优先使用只读或低副作用命令。任何配置、编译、依赖安装、清理或 Git 恢复操作，都必须先确认当前任务明确允许。标准构建命令见 [02_BUILD_AND_RUN.md](02_BUILD_AND_RUN.md)。

## 验收问题索引（A–O）

| 问题 | 现象 / 最可能原因 | 首查文件 | 只读检查命令 | 禁止操作 |
|---|---|---|---|---|
| A. CMake 找不到 Vulkan | configure 报 Vulkan 缺失；`VULKAN_SDK` 未设置或指向旧 SDK | `build_phase1b/CMakeCache.txt`、`CMakeLists.txt` | `echo %VULKAN_SDK%`；`findstr /i "Vulkan" vk_gaussian_splatting\build_phase1b\CMakeCache.txt` | 未授权安装 SDK、删除 build |
| B. Slang 下载或路径错误 | CMake 尝试下载或找不到 Slang；`Slang_ROOT` 错 | `build_phase1b/CMakeCache.txt`、`build/_deps/...2025.13.1` | `findstr /i "Slang" vk_gaussian_splatting\build_phase1b\CMakeCache.txt`；`dir vk_gaussian_splatting\build\_deps\Slang-windows-x86_64-2025.13.1` | 删除 `_deps`、随意替换版本 |
| C. 编译成功但找不到 EXE | 构建了错误配置或输出目录；应在 `_bin/Release` | `CMakeLists.txt`、构建日志 | `dir vk_gaussian_splatting\_bin\Release\vk_gaussian_splatting.exe` | 复制旧 EXE 冒充新产物 |
| D. EXE 启动失败 | DLL、Vulkan runtime/驱动或启动目录错误 | `_bin/Release/`、`CMakeLists.txt` | `dir vk_gaussian_splatting\_bin\Release\*.dll` | 从未知网站下载 DLL、清缓存 |
| E. PLY 加载失败 | 路径/扩展名/文件内容或 loader 状态错误 | `gaussian_splatting_ui.cpp`、loader | `dir vk_gaussian_splatting\flowers_1.ply`；`rg -n "onFileDrop|loadScene" vk_gaussian_splatting\src` | 打开大型二进制全文、改加载器掩盖错误 |
| F. Viewport 黑屏 | 场景未就绪、GBuffer/相机/渲染错误或窗口尺寸为零 | `gaussian_splatting_ui.cpp`、`gaussian_splatting.cpp` | `rg -n "Viewport|getDescriptorSet|loadScene" vk_gaussian_splatting\src` | 先改 shader/GBuffer、删除场景 |
| G. 面板消失 | `UiState` 开关关闭或窗口离开可视区 | `main_workspace.cpp`、`gaussian_splatting_ui.cpp` | `rg -n "Reset Monitoring Layout|show.*Window" vk_gaussian_splatting\src` | 删除未知 ImGui 配置而不备份 |
| H. Dock 布局异常 | 稳定窗口名变化或 dock builder 未重建 | `main_workspace.cpp`、`main.cpp` | `rg -n "buildMonitoringDockLayout|Viewport" vk_gaussian_splatting\src` | 改 `Viewport` 名、重写整个布局 |
| I. 地图滚轮影响相机 | map canvas hover 边界或上游相机输入协调失效 | `main_workspace.cpp`、`gaussian_splatting_ui.cpp` | `rg -n "InvisibleButton|IsItemHovered|MouseWheel" vk_gaussian_splatting\src` | 全局禁用相机输入 |
| J. 图表不更新 | 非 Running、面板未显示、250 ms 采样未到或 history 未写 | `main_workspace.cpp`、`application_state.h` | `rg -n "TrainingHistory|PerformanceHistory|250" vk_gaussian_splatting\src` | 改成每帧无界 push |
| K. 训练暂停后仍增长 | mock 状态未同步或采样条件未检查 Running | `mock_data_sources.cpp`、`main_workspace.cpp` | `rg -n "Paused|Running|requestPause" vk_gaussian_splatting\src` | UI 直接强写 `TrainingState` |
| L. 日志刷屏 | 逐帧事件未去重或转换检测错误 | `main_workspace.cpp`、`gaussian_splatting_ui.cpp` | `rg -n "addLog|previous.*Status|last.*" vk_gaussian_splatting\src` | 删除全部日志机制、扩大无界容量 |
| M. FPS 明显下降 | 面板/采样开销、不同场景/分辨率或 Debug 配置 | `main_workspace.cpp`、profiler 接入 | `rg -n "drawPerformance|ElementProfiler|PerformanceHistory" vk_gaussian_splatting\src` | 用不同条件数据下结论、先清 build |
| N. 修改代码后 EXE 没变化 | 构建了错误目录/配置，或 GLOB 未重新配置新 `.cpp` | `CMakeLists.txt`、`build_phase1b/CMakeCache.txt` | `dir /T:W vk_gaussian_splatting\_bin\Release\vk_gaussian_splatting.exe`；`findstr "CMAKE_HOME_DIRECTORY" vk_gaussian_splatting\build_phase1b\CMakeCache.txt` | 手改 `.vcxproj`、复制旧 EXE |
| O. Git 工作区混乱 | 混合已有修改、生成物或未跟踪文件 | Git index/工作树 | `git status --short`；`git diff --stat`；`git ls-files --others --exclude-standard` | `git clean`、`git reset --hard`、全仓 restore |

以下分节补充命令和背景；遇到多个症状时先按上表确定边界，不要同时修改 loader、UI 和 Vulkan 核心。

## 补充：程序无法启动

- 现象：EXE 不存在、双击无响应、提示缺少 DLL。
- 常见原因：尚未构建；从错误目录启动；Release DLL 未复制完整；Vulkan runtime/驱动不可用。
- 先检查：

```cmd
dir vk_gaussian_splatting\_bin\Release\vk_gaussian_splatting.exe
dir vk_gaussian_splatting\_bin\Release\*.dll
```

- 相关文件：`vk_gaussian_splatting/CMakeLists.txt`、`vk_gaussian_splatting/_bin/Release/`。
- 风险提示：不要从网上随机下载 DLL；不要删除整个 build 目录作为第一反应。

## 补充：CMake 找不到 Vulkan

- 现象：`find_package(Vulkan)` 失败，或 include/library 路径为空。
- 常见原因：`VULKAN_SDK` 未设置、指向旧版本，或命令行环境不是安装 SDK 后新开的终端。
- 只读检查：

```cmd
echo %VULKAN_SDK%
dir C:\VulkanSDK\1.4.341.1\Include\vulkan\vulkan.h
findstr /i "Vulkan_INCLUDE_DIR VULKAN_SDK" vk_gaussian_splatting\build_phase1b\CMakeCache.txt
```

- 当前已知 SDK：`C:\VulkanSDK\1.4.341.1`。
- 风险提示：修改系统环境变量或安装 SDK 是机器级变更，需单独授权。

## 补充：CMake 找不到 Slang

- 现象：Slang package、compiler 或 DLL 路径报错。
- 只读检查：

```cmd
dir vk_gaussian_splatting\build\_deps\Slang-windows-x86_64-2025.13.1
findstr /i "Slang" vk_gaussian_splatting\build_phase1b\CMakeCache.txt
```

- 当前已知本地版本：`2025.13.1`。
- 风险提示：`build/_deps` 是生成/依赖区，不要手工编辑；重新下载依赖需要网络并会改变工作区外观。

## 补充：新增源码没有进入构建

- 现象：新类链接不到，或修改后目标中没有新 `.cpp`。
- 原因：`CMakeLists.txt` 使用 `file(GLOB SOURCE_FILES src/*.*)`；已有生成系统可能未重新枚举文件。
- 只读检查：

```cmd
rg -n "file\(GLOB|SOURCE_FILES" vk_gaussian_splatting\CMakeLists.txt
rg -n "新符号名" vk_gaussian_splatting\src
```

- 处理：在允许配置的任务中重新运行 CMake configure；本次维护文档任务不允许执行。
- 风险提示：不要手改生成的 `.vcxproj`，下次配置会覆盖。

## 补充：场景文件无法加载

- 现象：Viewport 空、loader 报错、拖放无反应。
- 检查扩展名、路径是否存在、文件是否为支持的 PLY/SPZ，以及 loader 状态：

```cmd
dir /s /b vk_gaussian_splatting\*.ply vk_gaussian_splatting\*.spz
rg -n "onFileDrop|loadScene|prmScene" vk_gaussian_splatting\src\gaussian_splatting_ui.cpp
```

- 相关文件：`gaussian_splatting_ui.cpp`、场景 loader 和状态栏。
- 风险提示：不要用编辑器打开大型二进制场景；本地 `flowers_1.ply` 已被忽略，不是仓库基线的一部分。

## 补充：Viewport 消失或布局错乱

- 先用 View 菜单执行 `Reset Monitoring Layout`。
- 检查窗口名仍是精确的 `Viewport`：

```cmd
rg -n "Viewport|buildMonitoringDockLayout" vk_gaussian_splatting\src\main.cpp vk_gaussian_splatting\src\gaussian_splatting_ui.cpp vk_gaussian_splatting\src\main_workspace.cpp
```

- 风险提示：不要随意改窗口标题；dock 绑定依赖稳定名称。不要通过删除未知 ImGui 配置文件来“修复”而不先备份。

## 补充：面板没有数据或数值不动

- 检查 mock update、snapshot 同步和 workspace update 是否仍按帧调用：

```cmd
rg -n "m_mock.*update|snapshot|m_mainWorkspace.update|m_mainWorkspace.draw" vk_gaussian_splatting\src\gaussian_splatting_ui.cpp
```

- Robot 约 200 ms、Sensor 约 250 ms、Training 约 200 ms 更新；它们不会每个渲染帧都改变。
- 风险提示：不要为“更流畅”去掉时间步控制，否则曲线与状态机速度会依赖帧率。

## 补充：训练按钮状态异常

- 现象：Pause/Resume 不符合预期，训练自动停住或重启。
- 检查 `MockTrainingDataSource` 状态机、`TrainingCommand` 和 `WorkspaceCallbacks` 转发：

```cmd
rg -n "requestStart|requestPause|requestResume|requestStop|TrainingStatus" vk_gaussian_splatting\src\mock_data_sources.cpp vk_gaussian_splatting\src\gaussian_splatting_ui.cpp vk_gaussian_splatting\src\main_workspace.cpp
```

- 当前 mock 包含自动演示转换，不能等同于真实训练服务。
- 风险提示：UI 按钮不应直接写 `ApplicationState::training.status`。

## 补充：图表不更新或历史顺序错误

- 检查运行状态、采样间隔和 `RingBuffer`：训练曲线约 250 ms 采样；性能面板显示时约 250 ms 采样。

```cmd
rg -n "250|TrainingHistory|PerformanceHistory|RingBuffer" vk_gaussian_splatting\src\main_workspace.cpp vk_gaussian_splatting\src\application_state.h vk_gaussian_splatting\src\ring_buffer.h
```

- 风险提示：环形缓冲满后覆盖最旧样本是设计行为；不要改成无界 vector。

## 补充：Navigation Map 轨迹异常

- 检查 robot snapshot、约 100 ms 的路径采样和最大 1000 点容量。

```cmd
rg -n "Navigation|1000|navigation" vk_gaussian_splatting\src\application_state.h vk_gaussian_splatting\src\main_workspace.cpp
```

- 当前轨迹来自 Mock robot，不是地图坐标标定结果。
- 风险提示：真实坐标接入前必须定义单位、坐标系、原点和时间戳。

## 补充：快捷键误触发

- 检查 `GaussianSplattingUI::onUIMenu()` 对 `WantTextInput`、active item、`WantCaptureKeyboard` 和 Viewport hover 的实际保护。

```cmd
rg -n "WantTextInput|WantCaptureKeyboard|IsAnyItemActive|viewportHovered|IsKey" vk_gaussian_splatting\src\gaussian_splatting_ui.cpp
```

- 风险提示：不要只在单个窗口局部判断 hover；全局快捷键必须考虑 ImGui 整体捕获状态。

## 补充：GPU frame time 不显示

- 检查 profiler element 是否被加入，以及 `GaussianSplattingUI` 是否读取 profiler 数据。

```cmd
rg -n "ProfilerManager|ElementProfiler|gpu|GPU" vk_gaussian_splatting\src\main.cpp vk_gaussian_splatting\src\gaussian_splatting_ui.cpp
```

- 没有有效 profiler 数据时应显示 N/A，而不是伪造 0 ms。
- 风险提示：不要把 CPU wall-clock 时间标成 GPU 时间。

## 补充：状态栏 loader 状态卡住

- 检查 loader 的 busy/error/status 与 `RenderStatusView` 同步，以及场景事件去重逻辑。

```cmd
rg -n "RenderStatusView|loader|loadScene|addLog" vk_gaussian_splatting\src\gaussian_splatting_ui.cpp vk_gaussian_splatting\src\main_workspace.cpp
```

- 风险提示：不要为了隐藏错误而无条件清空 loader 状态；应保留可诊断信息。

## 补充：Release 缺少 DLL

- 对照 EXE 同目录的 DLL，并查看构建脚本中的复制规则：

```cmd
dir vk_gaussian_splatting\_bin\Release\*.dll
rg -n "copy|DLL|Slang|POST_BUILD" vk_gaussian_splatting\CMakeLists.txt vk_gaussian_splatting\cmake
```

- 风险提示：不要提交 `_bin` 或 DLL；它们是本地产物且已被忽略。

## 补充：Git 工作树不干净

- 先只读确认范围：

```cmd
git status --short
git diff --stat
git diff --name-only
git ls-files --others --exclude-standard
```

- 用 `git diff -- 文件路径` 人工检查每个已跟踪文件；用 `dir`/编辑器检查未跟踪文本文件。
- 风险提示：不要使用 `git reset --hard`、`git clean` 或批量 restore。它们可能销毁他人或用户的未提交工作；恢复必须逐文件、明确授权。
