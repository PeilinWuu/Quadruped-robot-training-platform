# UI 面板地图

[返回入口](00_START_HERE.md) · [状态与数据流](05_STATE_AND_DATA_FLOW.md) · [调试指南](08_DEBUGGING_GUIDE.md)

默认 dock 布局由 `buildMonitoringDockLayout()` 在 `vk_gaussian_splatting/src/main_workspace.cpp` 中建立。中央保持原生窗口名 **`Viewport`**；左、右、底部排列项目监控窗口。

## 默认布局

```text
┌──────────────────────────────────────────────────────────────┐
│ Project Status                                               │
├──────────────┬──────────────────────────┬────────────────────┤
│ Scene &      │                          │ Robot & Sensors    │
│ Environment  │        Viewport          │ Properties         │
│ Assets       │                          │                    │
├──────────────┴──────────────────────────┴────────────────────┤
│ Training / Charts / Performance / Navigation / Event Log /   │
│ Export / Profiler / Memory / Rendering（同一区域标签页）       │
└──────────────────────────────────────────────────────────────┘
│ 状态栏                                                       │
└──────────────────────────────────────────────────────────────┘
```

## 窗口清单

“View 开关”列的“有”表示项目或原应用的 View 菜单能恢复该窗口；“固定/原生”表示不由项目 `UiState` 管理。

| 窗口 | 绘制函数 / 源码 | 读取状态 | 修改/动作 | Mock | 影响 GS | 默认 Dock | View 开关 | 常见问题 |
|---|---|---|---|---|---|---|---|---|
| `Viewport` | `GaussianSplattingUI::onUIRender()` / `gaussian_splatting_ui.cpp` | GBuffer descriptor、相机/渲染状态 | 相机交互、显示场景 | 否 | 是，显示真实输出 | 中央 | 固定/原生 | 黑屏、名称改变导致 dock 失配 |
| `Project Status` | `MainWorkspace::drawProjectStatus()` / `main_workspace.cpp` | 项目、场景、训练、渲染摘要 | Reset Monitoring Layout | 混合 | 否 | 顶部 | 有 | 摘要滞后、布局复位无效 |
| `Scene & Environment` | `drawSceneAndEnvironment()` / 同上 | 场景摘要、环境状态 | 环境参数请求 | 环境是 Mock | 不直接影响 | 左侧 | 有 | 把环境控件误认为真实仿真 |
| `Robot & Sensors` | `drawRobotAndSensors()` / 同上 | Robot/Sensor snapshot | 机器人控制请求 | 是 | 否 | 右侧 | 有 | 200/250 ms 更新被误判为卡顿 |
| `Training Monitor` | `drawTrainingMonitor()` / 同上 | Training snapshot/history | Start/Pause/Resume/Stop | 是 | 否 | 底部标签 | 有 | mock 自动状态转换造成误解 |
| `Training Charts` | `drawTrainingCharts()` / 同上 | `TrainingHistory` | 只改显示范围 | 是 | 否 | 底部标签 | 有 | 非 Running 时不采样 |
| `Performance Charts` | `drawPerformanceCharts()` / 同上 | `PerformanceHistory`、GPU frame | 只改显示 | 指标尽量取实测 | 否 | 底部标签 | 有 | profiler 无数据时为 N/A |
| `Navigation Map` | `drawNavigationMap()` / 同上 | Navigation、robot、path ring | 地图显示/交互状态 | 是 | 否 | 底部标签 | 有 | 滚轮输入泄漏给相机、坐标含义误读 |
| `Event Log` | `drawEventLog()` / 同上 | `LogState` | Clear log、过滤/显示 | UI 日志 | 否 | 底部标签 | 有 | 未去重事件导致刷屏 |
| `Assets` | `guiDrawAssetsWindow()` / `gaussian_splatting_ui.cpp` | splat/资源信息 | 资源选择 | 否 | 可间接影响 | 左侧 | 原应用有 | 与场景加载状态不一致 |
| `Properties` | `guiDrawPropertiesWindow()` / 同上 | 渲染与资源参数 | 修改受支持的核心参数 | 否 | 是 | 右侧 | 原应用有 | 参数可直接改变渲染表现 |
| `Export Preview` | `m_exportPreview.draw()` / `gaussian_splatting_ui.cpp` | 导出预览状态 | 导出操作 | 否 | 不改变主渲染 | 底部标签 | 原应用有 | 导出资源/路径错误 |
| `Profiler` | `nvapp::ElementProfiler::onUIRender()` / `nvpro_core2` | profiler 数据 | 调试显示 | 否 | 不改变结果，可能有测量开销 | 底部标签 | 原应用有 | 与 FPS/GPU time 口径混淆 |

状态栏不是独立 dock 窗口，由 `MainWorkspace::drawStatusBar()` 绘制；它读取 loader、训练、机器人和 MOCK 摘要，不直接修改状态或 GS 渲染。

函数名称以当前源码为准；查找入口可执行：

```cmd
rg -n "drawProjectStatus|drawSceneAndEnvironment|drawRobotAndSensors|drawTrainingMonitor|drawTrainingCharts|drawPerformanceCharts|drawNavigationMap|drawEventLog|drawStatusBar" vk_gaussian_splatting\src\main_workspace.cpp
```

## View 菜单与恢复布局

- 项目窗口的可见性由 `ApplicationState::ui` 中的开关控制，并在 View 菜单提供入口。
- `Reset Monitoring Layout` 重新请求默认 dock 布局，用于窗口被关闭、拖离或布局损坏的情况。
- `Viewport` 是上游相机与渲染交互依赖的名称，禁止改名；默认 dock builder 也按该名称定位中央节点。
- 新增窗口时必须同时补齐：稳定窗口名、`UiState` 开关、View 菜单项、默认 dock 位置和 Reset 后恢复行为。

## 输入保护

当前全局键盘快捷键的实际条件是：没有 `WantTextInput`、没有 active item，并且键盘未被 ImGui 捕获（或 `Viewport` 正在 hover）。地图滚轮/拖动则由 invisible canvas 的 `IsItemHovered()` 限制。新增输入时应分别沿用对应保护方式，不能只检查按键或滚轮本身。

特别注意：

- Viewport 相机操作与面板滑块可能使用相同鼠标按键。
- 文本输入时不得触发文件、视图或训练快捷键。
- 按钮触发后应通过 `WorkspaceCallbacks` 和 `app_actions.h` 中的动作类型发请求，不在 draw 函数中直接操作渲染资源。

## MOCK 标记规则

所有可能被误认为真实机器人、真实传感器或真实训练后端的数据，应在面板或状态栏保持清晰的 `MOCK` 标记。接入真实后端前，不要仅通过删除标签来改变产品含义；应先完成数据源、连接状态、失败处理和验证。
