# V1 火焰遮挡修正（2026-09-09）

V1 现在按场景深度截断视线上的火焰积分。保留颜色公式、燃料映射和 96 步采样。
默认开启「遮挡」，可关闭对照。多点火焰与氛围共用一次全分辨率深度渲染。

原有 5 cm 方块代理产生明显方格，新增 export_smooth_fire_depth.py 以 sigma=0.6 体素、
0.4 等值面生成平滑表面，未覆盖原 proxy.bin 或仿真文件。
新文件 fire_playback_v2/table_high_test/proxy-smooth.bin，7,519,464 字节，已包含于安装包。
SHA256: 8ae4ee86b16960ad2184ab748157538e9f45ef8a8e3ea7f9079009f9e14b39fb

深度加载失败会显示提示并保留原播放能力，此时火焰没有遮挡。烟雾仍隐藏。

验证：
- 119 前端测试通过；TypeScript、Vite、Tauri release 和 NSIS 打包通过。
- verify-fire-occlusion.mjs：真实场景三个视角同帧开关对照；三处约 60 FPS；暂停、重置、第一视角、资源清理通过。
- verify-fire-occlusion-extended.mjs：人工测试遮挡几何在火前时，与无火画面差异为 0 像素；在火后时，与无遮挡画面差异为 0 像素；基准火焰有 82,665 个可辨像素。
- 五个移动位置和变化 FOV 截图；第一视角和 960x640 尺寸同步；深度 404 故障显示 unavailable 且保持播放。
- 打包后的新代理 SHA256 与源一致。

边界：代理仍源于 5 cm 占据体素，并非精确高斯深度。窗帘、曲面、细小物体附近仍有
边缘偏差，表面内部的火焰会被截断。此次解决主要穿透路径，不宣称全部边缘完全准确。
桌面安装版还需人工验收。截图和报告位于 tmp/fire-occlusion-results。

## 着火窗帘自身遮挡修正

此前全场景统一深度会裁掉贴附着火物的火焰。现在 curtain_high 单独使用一个深度通道，
在该通道排除 labels.json 中实例 62 的薄层范围（源坐标转 Y-up，约 4 cm 容差）。
其他火焰及烟雾仍使用完整深度。不是整个火焰包围盒豁免，也没有取消其他物体的遮挡。
这属于针对 office_01 的展示修正：空间范围不能精确区分与窗帘重叠的墙面，尚非逐面实例标签。
着火物背面的火焰物理上仍可能被自身遮挡；本轮仅采用薄窗帘的展示豁免，不推广至所有实体家具。

参考 NVIDIA GPU Gems 3 第 30 章的不透明深度射线截断，以及第 23 章的软交界讨论。
按发射物划分遮挡通道是本项目据此采用的工程策略，不是上述文献给出的现成算法。
https://developer.nvidia.com/gpugems/gpugems3/part-v-physics-simulation/chapter-30-real-time-simulation-and-rendering-3d-fluids
https://developer.nvidia.com/gpugems/gpugems3/part-iv-image-effects/chapter-23-high-speed-screen-particles

verify-fire-owner-occlusion.mjs 输出同帧自遮挡开关截图，并验证窗帘前外部遮挡物：
开火与隐藏窗帘火焰的图像差异为 0 个可辨像素。浏览器无错误，三处约 59–60 FPS。
Tauri 安装包已重新生成。未重做物理仿真。
