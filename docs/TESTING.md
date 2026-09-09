# 测试与人工验收

[文档索引](README.md)

## 无外部场景的基础检查

仓库根目录，Node 24：

```powershell
npm ci
npm run build:go2-visuals
npm run typecheck
npm run lint
npm test
npm run build
```

`npm test` 包含 Node 认证/资源检查与 Vitest 前端测试；Node 资源测试会读取生成 GLB，因此不能省略首次生成。基础检查不需要 office_01 或 FieryGS。GitHub Actions 执行上述检查；它不代表 GPU 视觉或桌面安装验收。

Rust 改动在 `src-tauri` 中运行 `cargo fmt --check`、`cargo clippy --all-targets --all-features -- -D warnings`、`cargo test`。C++ 改动从仓库根目录运行 `npm run setup:mpc` 和 `npm run build:sidecar`（含 CTest）。

## 桌面人工验收

记录提交号、Windows/GPU、场景名称、数据版本、观察视角、播放帧与参数；结果应能由另一人复现。

| 项目 | 操作与预期 |
| --- | --- |
| 启动 | 桌面注册/登录、导入 SOG、重启后场景库仍可读取 |
| GS | 旋转/缩放/调整朝向，卸载后清理旧画面 |
| 火场 | V1 加载、播放/暂停、多点模式；桌子/沙发/窗帘位置匹配 |
| 遮挡 | 家具挡住后方火焰，移动视角及时更新；检查窗帘表面火焰可见度 |
| 深度 | 深度图随相机更新，前后表面顺序合理，无场景时不保留旧帧 |
| 热像 | 三处热源对应、遮挡正确、色带/暂停有效；只显示相对热度 |
| 空气墙 | WASD/QE 检查阻挡、滑行、退出重叠、关闭对照及转角 |
| 台阶 | “台阶贴地→查看台阶样例”，三种站姿分别贴面，退出恢复状态 |

空气墙和台阶只适用 office_01。台阶按钮切换是重新放置，不是行走测试。详细验收见 [空气墙](ROBOT_AIR_WALLS.md)、[台阶](LOCAL_STEP_STANDING_DEMO.md)、[深度](GS_REALTIME_DEPTH.md)、[热像](SIMULATION_THERMAL_PREVIEW.md)。

## 研究用浏览器验收脚本

`scripts/verify-gs-depth.mjs`、`verify-gs-gpu-fire.mjs`、`verify-thermal.mjs`、`verify-robot-collision.mjs`、`verify-step-demo.mjs` 等使用真实 SOG 和 `tools/fire-playback-v2/fixture.html`。它们不是 `npm test` 的一部分。

这些脚本目前保留原开发机的 Playwright runtime 路径、Edge channel、D 盘场景路径，并依赖 GPU/WebGL2。其他机器需先配置 Playwright、修改脚本中的导入/场景路径，启动 5173 Vite，再执行。不要直接运行后把路径报错当作产品回归；未来应统一为便携测试入口。

截图和报告默认在 `tmp/`，不提交到 Git。调试网格通常不受 GS 遮挡，关闭“接触面/显示碰撞范围”再评价最终观感。IK 数值误差只验证骨架贴合代理，不等于代理与真实场景的测量精度。
