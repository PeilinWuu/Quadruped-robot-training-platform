# 故障排查

[文档索引](README.md)

## 打开的是网页，没有桌面功能

`npm run dev` 启动网页。桌面使用 `npm run tauri -- dev`；没有外部场景时先完成导入。安装版修改源码后不会自动更新，需要重新构建安装，或使用开发模式。

## 5173 被占用

Vite 配置 `strictPort`，不会改用其他端口。关闭自己之前启动的开发终端再启动。若有意复用已运行的本项目 Vite，可创建本地 `tmp/tauri-reuse-dev.json`：

```json
{"build":{"beforeDevCommand":""}}
```

```powershell
npm run tauri -- dev --no-watch --config tmp/tauri-reuse-dev.json
```

先确认 5173 确实是本项目并已生成 Go2 资产；该配置不会帮你启动 Vite。

## Go2 生成目录 EPERM / rename 失败

Windows 上浏览器、开发服务器或文件查看器可能占用 `public/robot-visuals/unitree-go2/generated`。关闭自己打开的相关视图/开发进程后重试 `npm run build:go2-visuals`，不要同时构建与视觉验收，也不要删除源码/锁文件。`npm run verify:go2-visuals` 可检查现有 GLB 是否完整。

## 火焰 404 或打包找不到 D 盘文件

配置 `.env.local` 中的 `GS_SCENE_DATA_ROOT` 并检查四组播放目录、V1 温度附加帧。没有数据而只需基础桌面包时设 `BUNDLE_FIRE_PLAYBACK=0`。该选项不隐藏火焰 UI，也不生成替代数据。

## 深度或热像没有画面

先确认 GS 已加载、GPU 支持 WebGL2。热像需要 V1，V2 无对应温度通道；缺温度帧会提示错误。深度空洞显示未知区域，不能从展示颜色反推可信温度。参考 [热像说明](SIMULATION_THERMAL_PREVIEW.md)。

## 空气墙或台阶不出现 / 位置不对

样例按 `office_01` / `scene_yup` 场景名启用，但几何只对原 office_01 有效。核对场景朝向、机器人标定和数据来源，不要给其他场景套用该配置。台阶高度和边缘可在样例工具栏局部调节。

## Node SQLite 报错 / 浏览器登录失败

使用 Node 24。确保 `npm run dev` 同时启动 API；`dev:web` 单独运行没有认证服务。Express 不自动读取 `.env.local`，自定义数据库/端口要设置进程环境变量。桌面和浏览器账号不共享。

## Sidecar 缺失

先执行 `npm run setup:mpc`、`npm run build:sidecar`。当前默认 Tauri 启动不自动执行这些步骤，默认安装包也不包含原生仿真资源。源码里有 MuJoCo 模块不代表安装包已具备该功能。
