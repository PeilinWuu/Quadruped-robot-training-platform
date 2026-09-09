# 贡献指南

先按 [快速开始](docs/GETTING_STARTED.md) 启动应用，再阅读 [系统架构](docs/ARCHITECTURE.md) 和相关专题。讨论时请注明是在桌面、浏览器夹具还是 MuJoCo 中复现。

## 工作流程

1. 在 Issue 或团队讨论中确认问题、预期行为和验收方式。
2. 从团队指定的集成分支创建主题分支；不要假设本地研究分支就是默认分支。
3. 一个 PR 聚焦一个问题；展示优化与物理/训练数据改动分别说明。
4. 完成相应测试，更新使用文档；视觉改动附前后对比截图和观察条件。
5. 本地审查 diff、提交，再按团队审核约定推送和创建 PR。本项目当前协作方式允许先本地提交，待维护者人工审核后推送。

示例（已处于正确基线分支时）：

```powershell
git switch -c codex/describe-change
git diff
git add src/path/to/changed-file.ts
git diff --cached --check
git diff --cached
git commit -m "fix: describe the behavior change"
```

不要直接 `git add .` 收入实验数据。推荐提交前缀 `feat:`、`fix:`、`docs:`、`test:`、`build:`、`refactor:`；标题说明结果，正文解释必要的取舍和验证。

## 代码约定

- React UI 在 `src/components/`；渲染生命周期放在 `src/features/gaussian-viewer/`，避免在组件中直接管理 GPU 资源。
- 服务负责状态和运行时适配，数学/采样函数保持可独立测试。遵循所在文件的 TypeScript 风格。
- Web/Tauri 通过 adapter 分流。未实现的真实操作应显式报错，不用 Mock 冒充成功。
- 相机矩阵、深度采样和帧数据须保持时间对应；销毁时释放纹理、监听器、Worker 和约束回调。
- GS 坐标、机器人标定、仿真坐标须明确命名和变换；不要在多处叠加“修正偏移”。
- 升级依赖须提交相关锁文件；Go2 资产保持来源、哈希和许可证。不要手工修改生成 GLB 绕过验证。
- 涉及 native 协议时同步更新 Rust、C++、TypeScript 类型及相应测试。

## 提交前检查

首次安装后先生成模型，再运行基础检查：

```powershell
npm run build:go2-visuals
npm run typecheck
npm run lint
npm test
npm run build
git diff --check
```

纯文档更改主要检查链接和命令一致性；修改渲染还需[视觉验收](docs/TESTING.md)，修改 Rust/C++ 还需对应原生测试。测试声明应写实际执行结果，不复制旧报告中的通过数量。

## PR 描述

使用仓库 PR 模板，包含：问题与最终行为、涉及模块、验证命令与结果、需要的数据或人工检查项。视觉对比注明场景、视角、播放帧和开关。不要把尚未进行的人工验收写成通过。

不要提交密码、会话、个人数据库、未经许可的场景或大规模回放数据。临时截图留在 `tmp/`，有权公开的精简截图可以作为 PR 附件。项目整体许可证尚未确定，新增第三方代码和资源应说明来源。
