# 建筑室内火灾场景四足机器人自主搜索与避障训练系统（GUI 原型）

一个可运行的高保真全栈原型，用于演示建筑火灾环境中的场景配置、仿真监控、传感器画面、训练指标和机器人状态。用户注册、登录、退出和会话恢复由真实本地后端与 SQLite 数据库提供；仿真和机器人业务数据仍默认来自 Mock 适配器。

## 安装与启动

要求 Node.js 20.19+ 或 22.12+。

```bash
npm install
npm run dev
```

该命令会同时启动前端和认证 API。首次访问时先注册账号；账号会持久化到 `data/auth.sqlite`。该目录已加入 Git 忽略列表。

生产构建与检查：

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

## 目录结构

```text
src/
├─ components/      # 页面面板与独立仿真视图组件
├─ config/          # 数据源、API 与 WebSocket 配置
├─ services/        # 服务契约、Mock 实现、真实适配层和统一出口
├─ store/           # Zustand 页面状态与本地交互
├─ types/           # 领域数据模型
├─ App.tsx          # 页面组合与主题配置
├─ App.css          # 工业监控界面样式与响应式规则
└─ main.tsx         # React 入口
server/
├─ auth.ts          # scrypt 密码哈希、验证及安全令牌
├─ database.ts      # SQLite 用户和会话表
├─ index.ts         # 注册、登录、退出、会话恢复 API
└─ auth.test.ts     # 认证安全单元测试
```

## Mock / 真实数据切换

复制 `.env.example` 为 `.env.local`，通过 `VITE_DATA_SOURCE` 选择数据源：

```env
VITE_DATA_SOURCE=mock
```

组件只依赖 Zustand store，store 通过 `src/services/index.ts` 的统一服务出口获取数据，不直接导入 Mock。将配置改为 `real` 后会进入 `src/services/real.ts`；该适配器目前会明确报告“尚未接入”，不会伪造成功结果。

## 后端与仿真能力接入

- REST / RPC：在 `src/services/real.ts` 中实现 `SceneService`、`SimulationService`、`TrainingService`、`RobotService` 和 `SensorService`，基础地址读取 `VITE_API_BASE_URL`。
- WebSocket / ROS：在真实 `SensorService.subscribe` 或新增流式客户端中连接 `VITE_WS_URL`，将消息转换为 `src/types` 中的数据模型后写入 store。
- 视频流：替换 `src/components/SimulationView.tsx` 内部的占位视图，可接入 WebRTC、HLS、MJPEG 或 ROS 图像桥。
- Three.js / Unity：保持 `SimulationView` 的外部状态与动作 API，在组件内部挂载 Canvas、Unity WebGL 或远程渲染画面。
- ECharts：训练服务返回 `TrainingMetrics[]` 即可替换当前动态模拟曲线。

所有暂未实现的导航、场景编辑和仿真标注操作均提供界面反馈，提示对应接口已预留。

## 用户认证

- 注册：校验用户名、邮箱、姓名、密码强度和重复账号。
- 密码：使用 Node.js 原生 `scrypt` 配合随机盐哈希，数据库不保存明文密码。
- 会话：随机 256 位令牌仅通过 HttpOnly、SameSite=Strict Cookie 返回浏览器；数据库只保存令牌的 SHA-256 摘要。
- 保护：未认证用户无法进入监控界面；刷新页面会从服务端恢复会话；退出时同时撤销服务端会话和 Cookie。
- 生产环境：必须经 HTTPS 反向代理运行并设置 `NODE_ENV=production`，此时 Cookie 会自动启用 `Secure`。
