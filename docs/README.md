# 文档索引

[项目首页](../README.md)

## 使用与共同开发

- [受邀共同开发者入口](COLLABORATOR_QUICKSTART.md)：一个共享资产包、一条导入命令，运行完整展示。

- [快速开始](GETTING_STARTED.md)：环境、桌面/浏览器启动、构建与原生模块。
- [数据与资源](DATA_ASSETS.md)：外部数据、目录结构、变量和许可证。
- [贡献指南](../CONTRIBUTING.md)：分支、代码约定、检查和 PR。
- [系统架构](ARCHITECTURE.md)：展示、资源和物理仿真的边界与代码地图。
- [测试与人工验收](TESTING.md)：基础 CI 与依赖真实场景的视觉测试。
- [故障排查](TROUBLESHOOTING.md)：端口、文件锁、资源和运行时问题。
- [路线图](ROADMAP.md)：当前能力、限制与后续研究方向。

## 当前功能专题

这些文档说明特定实现和验收方法，其中的测试数量是当次记录。统一启动和数据配置以上面的入门文档为准。

| 功能 | 文档 |
| --- | --- |
| GS 深度 | [真实深度捕获](GS_REALTIME_DEPTH.md)、[GPU 火焰遮挡](GS_GPU_FIRE_DEPTH.md) |
| 热像 | [仿真相对热像](SIMULATION_THERMAL_PREVIEW.md) |
| 多点火场 | [房间火场原型](ROOM_FIRE_PROTOTYPE.md)、[氛围展示](ROOM_FIRE_ATMOSPHERE.md) |
| 窗帘 | [表面对齐](CURTAIN_SURFACE_ALIGNMENT.md) |
| 机器人碰撞 | [空气墙与矩形判定](ROBOT_AIR_WALLS.md) |
| 地面/台阶 | [地面调查](GROUND_STEPS_PLAN.md)、[局部站立样例](LOCAL_STEP_STANDING_DEMO.md) |
| 原生物理 | [MuJoCo Sidecar](../native/mujoco-sidecar/README.md) |
| 离线运动工具 | [运动资产转换](../tools/robot_motion/README.md) |

## 历史设计与审计

保留原文件名便于旧链接和研究追溯。这些文件不是当前快速启动指南；本机路径、临时命令、V2 评估和“尚未实现”描述只代表成文时状态。

- [V2 审计](FIRE_PLAYBACK_V2_AUDIT.md) 与 [V2 报告](FIRE_PLAYBACK_V2_REPORT.md)
- [V2 数据 schema](fire-playback-v2.schema.json)
- [初版遮挡](FIRE_OCCLUSION_V1.md) 与 [深度阶段记录](PROJECT_STATUS_GAUSSIAN_DEPTH.md)
- [FieryGS 求解器启动审计](FIERYGS_SOLVER_BOOTSTRAP_AUDIT.md)
- [FieryGS 展示集成审计](FIERYGS_SHOWCASE_INTEGRATION_AUDIT.md)
- [自动场景集成审计](AUTO_SCENARIO_INTEGRATION_AUDIT.md)
- [点火选择器 V2 设计](IGNITION_SELECTOR_V2_DESIGN.md)
- [房间场景生成器 V2 设计](ROOM_SCALE_FIRE_SCENARIO_GENERATOR_V2_DESIGN.md)
- [早期更新记录](../update.md)

## 如何维护文档

新用户流程放入入门文档；跨模块职责放入架构；具体算法和验收放入专题。新增文档后在此登记。改变默认行为时同时更新首页状态表，历史审计不追写成“当前已完成”。
