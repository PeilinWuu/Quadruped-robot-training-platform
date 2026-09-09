# GS 实时深度检查与面板（2026-09-09）

结论：当前 PlayCanvas 2.21.1 可以从真实 SOG 的 Gaussian 绘制得到深度。
原 SensorPanel 深度仅轮播三张 public/gaussian-depth PNG；现已替换为实时深度画布。

## 使用

安装新版后导入场景，在传感器视图选择「GS 实时深度」。跟随当前主视口相机，
切换机器人第一视角后对应机身相机。近白远黑，0–6 米可视化，原始值保留完整距离。
悬停读取相机前向深度（不是沿射线欧氏距离）；0 为无有效深度。
可切换透明度阈值 0.1 / 0.3 / 0.5。宽度最多 640，保持视口比例，读取上限 5 Hz。

## 实现与限制

单独 GS 图层，仅捕获场景，不包含火焰、烟雾或机器人网格。Picker depth MRT 使用
相同主相机与 GS 场景变换。原生 GS shader 的 alphaClip 阈值默认 0.3，不是累计透射率深度。
拾取通道原本依赖绘制排序，整帧深度适配器在该通道临时开启最近表面深度写入，随后恢复。
RGBA 保存 big-endian IEEE754 normalized depth；按 near + normalized*(far-near) 转米并翻转行序。

整帧读取依赖 pinned 2.21.1 Picker 内部 depthBuffer/renderTargetDepth 及 pick mesh map，
已集中隔离在 GaussianDepthCapture；引擎升级需要重新验证。没有更新 node_modules。
无效像素不补洞；阈值导致的透明边缘缺口和高斯表面近似仍待人工验收。
此轮没有将 5 Hz CPU 回读接入火焰。下一阶段应复用 GPU 深度纹理并逐帧同步，而非直接使用延迟回读。
既有代理遮挡与窗帘豁免本轮未修改。GS 深度不作为训练传感器真值。

## 验证

121 前端测试、TypeScript、Vite、Tauri release 和 NSIS 打包通过。
verify-gs-depth.mjs 在真实 SOG/RTX 4060 WebGL2 测试三视角 RGB/深度：
- 解码与四个引擎单点采样差异小于 1 mm；上下翻转与 near/far 解码单测通过。
- 窗帘中心约 2.754 m，吊灯采样点约 0.978 m。
- alpha 0.1/0.3/0.5 的有效像素分别为 230385/230235/229486（640×360）。
- 静止中心连续采样稳定；第一视角与 960×640 视口对应深度 640×427；卸载场景清空数据。
- 面板、阈值控件测试通过，不再使用静态 PNG。
- 安装版仍需人工视觉验收。结果在 tmp/gs-depth-results/report.json 与 rgb-depth-comparison.jpg。

参考：
https://developer.playcanvas.com/user-manual/gaussian-splatting/building/picking/
https://api.playcanvas.com/engine/classes/GSplatParams.html
公开文档为更新版本，实施以本地 2.21.1 源代码为准。
