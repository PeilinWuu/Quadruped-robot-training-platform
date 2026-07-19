# 安全修改指南

[返回入口](00_START_HERE.md) · [源码所有权](03_SOURCE_OWNERSHIP.md) · [调试指南](08_DEBUGGING_GUIDE.md)

本项目同时包含上游 Vulkan 渲染核心、项目监控 UI、Web 参考前端、生成目录和大型场景资产。一次任务只解决一个阶段目标，不跨多个架构层顺手重构。

## 固定流程

1. **确认 Git 干净**：执行 `git status --short`；若不干净，记录并保护已有修改。
2. **创建阶段分支**：仅在用户明确授权切换分支时执行，命名应表达单一阶段目标。
3. **描述单一目标**：写清验收条件、不做事项和允许的验证方式。
4. **先只读分析**：阅读 `AGENTS.md`、相关维护文档、声明、实现和调用点。
5. **列出将修改文件**：先判断项目层、集成层或上游层；不要一次修改多个架构层。
6. **建立基线**：记录分支、HEAD、现有 `git status`；需要性能比较时固定场景、分辨率、配置和采样方法。基线提交必须经用户授权。
7. **小步修改**：一次只改变一个行为；没有解释时不重写整个文件，也不全仓格式化。
8. **每步构建**：仅在任务授权构建时执行；新增 `.cpp` 可能先需 CMake configure。绝不自动清理构建目录。
9. **人工运行验证**：仅在任务授权运行时执行；检查 Viewport、相关面板、输入保护、MOCK 标记和退出。
10. **查看 Git diff**：运行 `git diff --check`、`git diff --stat`、`git diff --name-only` 并逐文件复核。
11. **提交和打标签**：仅在用户明确要求后执行；提交前复核 staged diff，tag 只标记已经验证、含义清晰的基线。

“没有权限执行构建”不等于“构建已通过”。交付必须区分：静态检查、编译、运行和性能验证。

## 风险等级

| 等级 | 典型修改 | 要求 |
|---|---|---|
| 低 | 面板文案、轻量状态字段、Mock 数值、日志事件 | 静态检查；若行为变化则运行相关面板 |
| 中 | `MainWorkspace`、数据源接口、Dock 布局、`gaussian_splatting_ui` 接入 | 小补丁、完整调用链复核、获准后编译和人工运行 |
| 高 | `GaussianSplatting`、GBuffer、CameraManipulator、Shader、`nvpro_core2`、加载器 | 独立专项、上游审查、GPU/场景/性能回归，不与 UI 功能混改 |

## 架构规则

- 数据保持单向：data source → snapshot → `ApplicationState` → `MainWorkspace`。
- UI 动作通过 `app_actions.h` 的动作类型和 `WorkspaceCallbacks` 返回集成层，不让面板持有核心对象。
- 项目窗口集中在 `MainWorkspace`；`Viewport`、Assets、Properties 和渲染资源留在集成/上游层。
- 真实后端应实现数据源接口；保留 mock 离线模式和明确 `MOCK` 标记。
- 新快捷键必须检查 ImGui 文本输入和键鼠捕获状态。
- 新窗口必须有 View 菜单开关、默认 dock 位置和 Reset Monitoring Layout 恢复路径。
- 不把 build、`_bin`、DLL、SDK、下载依赖或大型 PLY/SPZ 提交到 Git。

## Git 与回滚安全

- 默认只读；不自动 add、commit、switch、reset、tag 或 push。
- 不使用 `git reset --hard`、`git clean -fd` 或全仓 `git restore .`。
- 已有修改默认属于用户；无法区分所有权时停止并报告。
- 撤销未提交修改前先用 `git diff -- 明确文件` 检查，只回滚自己确认的文件。
- 已提交且已共享的错误优先用反向提交修复，不改写共享历史。

## Codex 必须遵守

- 不一次修改多个架构层。
- 不在没有解释时重写文件。
- 不自动清理构建目录或依赖缓存。
- 不伪造配置、编译、运行或性能验证。
- 不将 Mock 宣称为真实功能。
- 不访问已废弃工作区；事实来自当前源码、Git 和当前本地元数据。

## 交付清单

- 修改文件及原因。
- 未触碰的层和目录。
- 实际运行的检查，以及因限制未运行的检查。
- `git status --short` 和 `git diff --stat`。
- 已知风险、回滚边界和下一步建议。
