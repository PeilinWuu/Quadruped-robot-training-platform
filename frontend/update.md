# 项目功能与接口更新说明

更新日期：2026-07-13

## 1. 项目当前状态

本项目目前是一个可运行的 React + TypeScript + Vite 全栈原型，包含高保真的火灾场景四足机器人训练监控 GUI 和真实的本地用户认证后端。

需要特别区分两类能力：

- **已经真实实现**：用户注册、登录、退出、登录状态恢复、用户与会话持久化。
- **目前仍为 Mock**：场景业务数据、仿真控制、训练算法、机器人控制、传感器数据、视频流、ROS、Unity、Three.js 和 WebSocket 实时数据。

界面中的未接入功能会给出“接口已预留，等待后端接入”等反馈，不会伪装成已经完成真实控制。

## 2. 已完成的功能

### 2.1 用户认证

- 用户注册：支持姓名、用户名、邮箱和密码。
- 注册校验：校验用户名格式、邮箱格式、姓名长度和密码强度。
- 重复校验：用户名和邮箱均不可重复注册。
- 密码安全：使用 Node.js 原生 `scrypt` 和随机盐进行哈希，数据库不保存明文密码。
- 用户登录：支持通过用户名或邮箱登录。
- 会话管理：使用随机会话令牌和 HttpOnly Cookie。
- 会话恢复：刷新浏览器后会向服务端验证 Cookie 并恢复用户状态。
- 安全退出：退出时同时删除数据库会话并清除 Cookie。
- 登录保护：未登录用户不能进入监控主界面。
- 基础限流：注册和登录接口按客户端地址限制尝试次数。
- 数据持久化：用户及会话保存在 SQLite 数据库 `data/auth.sqlite` 中。

### 2.2 监控 GUI

- 顶部系统标题、模块导航、当前登录用户和退出入口。
- 左侧场景列表、场景信息和环境参数。
- 中央独立仿真主视图占位组件。
- 仿真暂停、继续、停止、重置和倍速切换。
- RGB、深度、热成像和激光雷达传感器标签切换。
- 2D 环境地图。
- 训练任务、进度、奖励、回合和时间信息。
- 奖励曲线、成功率和损失曲线动态模拟。
- 机器人电量、温度、关节、步态、速度和位置状态。
- 自主、辅助和手动控制模式切换。
- 底部系统状态栏。
- 适配 1920×1080，并允许较小分辨率通过紧凑布局或滚动访问。

### 2.3 工程能力

- 使用 TypeScript 定义领域数据模型。
- 使用 Zustand 统一管理业务页面状态。
- 使用 Ant Design 构建表单和交互控件。
- 使用 ECharts 展示训练指标。
- 使用 Lucide React 提供图标。
- Mock 实现与真实适配层分离。
- 组件不直接导入 Mock 数据。
- 已配置类型检查、Lint、认证单元测试和生产构建命令。

## 3. 主要目录说明

```text
server/
├─ auth.ts                # 密码哈希、密码校验、会话令牌生成与摘要
├─ auth.test.ts           # 认证安全单元测试
├─ database.ts            # SQLite 初始化、用户表和会话表
└─ index.ts               # Express 认证 API

src/
├─ components/
│  ├─ AuthScreen.tsx      # 登录和注册界面
│  ├─ Header.tsx          # 顶部导航、当前用户和退出按钮
│  ├─ SimulationView.tsx  # 可替换的仿真主视图
│  ├─ SensorPanel.tsx     # 传感器视图
│  ├─ MapPanel.tsx        # 2D 地图
│  ├─ TrainingPanel.tsx   # 训练任务
│  ├─ ChartsPanel.tsx     # 训练曲线
│  └─ RobotPanel.tsx      # 机器人状态
├─ config/
│  └─ dataSource.ts       # Mock/真实数据源和连接地址配置
├─ services/
│  ├─ contracts.ts        # 五类业务服务的 TypeScript 接口
│  ├─ mock.ts             # 当前业务 Mock 实现
│  ├─ real.ts             # 真实业务适配层预留位置
│  ├─ index.ts            # 统一服务出口及数据源选择
│  └─ authService.ts      # 前端认证 API 客户端
├─ store/
│  └─ useAppStore.ts      # 页面状态和本地交互
├─ types/
│  └─ index.ts            # 场景、训练、机器人和传感器模型
└─ App.tsx                # 登录保护和监控界面组合
```

## 4. 已实现的认证接口

认证服务默认监听 `http://localhost:3001`，Vite 开发服务器通过 `/api` 代理访问。

### 4.1 注册

```http
POST /api/auth/register
Content-Type: application/json

{
  "username": "operator01",
  "email": "operator01@example.com",
  "displayName": "操作员一号",
  "password": "FireRobot2026"
}
```

成功返回 HTTP 201，并设置 HttpOnly 会话 Cookie：

```json
{
  "user": {
    "id": 1,
    "username": "operator01",
    "email": "operator01@example.com",
    "displayName": "操作员一号",
    "role": "operator",
    "createdAt": "2026-07-13 10:00:00"
  }
}
```

### 4.2 登录

```http
POST /api/auth/login
Content-Type: application/json

{
  "account": "operator01",
  "password": "FireRobot2026"
}
```

`account` 可以填写用户名或邮箱。成功后返回用户信息并设置会话 Cookie。

### 4.3 获取当前用户

```http
GET /api/auth/me
```

- 已登录：HTTP 200，返回当前用户。
- 未登录或会话过期：HTTP 401。

### 4.4 退出登录

```http
POST /api/auth/logout
```

成功返回 HTTP 204，同时撤销服务端会话并清除 Cookie。

### 4.5 前端调用位置

前端认证客户端位于 `src/services/authService.ts`：

```ts
authService.register(input)
authService.login(input)
authService.me()
authService.logout()
```

请求统一带有 `credentials: 'include'`，以便浏览器发送 HttpOnly Cookie。组件不应自行拼接认证请求，后续认证接口改动应集中在这个文件中处理。

## 5. 预留的业务服务接口

接口定义集中在 `src/services/contracts.ts`，真实实现应写入 `src/services/real.ts`。

### 5.1 SceneService

用途：获取场景、查看单个场景和保存环境参数。

```ts
interface SceneService {
  list(): Promise<ServiceResult<Scene[]>>
  get(id: string): Promise<ServiceResult<Scene>>
  updateEnvironment(
    id: string,
    params: EnvironmentParams,
  ): Promise<ServiceResult<EnvironmentParams>>
}
```

建议对应后端接口：

- `GET /api/scenes`
- `GET /api/scenes/:id`
- `PUT /api/scenes/:id/environment`

### 5.2 SimulationService

用途：控制仿真生命周期和仿真速度。

```ts
interface SimulationService {
  start(): Promise<ServiceResult<void>>
  pause(): Promise<ServiceResult<void>>
  stop(): Promise<ServiceResult<void>>
  reset(): Promise<ServiceResult<void>>
  setSpeed(speed: number): Promise<ServiceResult<number>>
}
```

建议对应后端接口：

- `POST /api/simulation/start`
- `POST /api/simulation/pause`
- `POST /api/simulation/stop`
- `POST /api/simulation/reset`
- `PUT /api/simulation/speed`

接入后，`SimulationView.tsx` 中的控制按钮应调用 store action，再由 store 调用 `services.simulation`，不要直接在组件中调用具体 Mock 或真实实现。

### 5.3 TrainingService

用途：获取训练任务和训练指标。

```ts
interface TrainingService {
  getTask(): Promise<ServiceResult<TrainingTask>>
  getMetrics(): Promise<ServiceResult<TrainingMetrics[]>>
}
```

建议对应后端接口：

- `GET /api/training/task/current`
- `GET /api/training/metrics`

实时训练指标可继续扩展为 WebSocket 订阅。收到服务端数据后，将其转换成 `TrainingMetrics` 再写入 Zustand store。

### 5.4 RobotService

用途：获取机器人状态和修改控制模式。

```ts
interface RobotService {
  getState(): Promise<ServiceResult<RobotState>>
  setControlMode(
    mode: RobotState['controlMode'],
  ): Promise<ServiceResult<RobotState['controlMode']>>
}
```

建议对应后端接口：

- `GET /api/robot/state`
- `PUT /api/robot/control-mode`

真实控制接入时，服务端应负责权限、机器人在线状态和指令确认。前端不能仅因请求发出就显示控制成功，应以服务端确认结果为准。

### 5.5 SensorService

用途：读取传感器快照和订阅连续数据。

```ts
interface SensorService {
  getSnapshot(): Promise<ServiceResult<SensorSnapshot>>
  subscribe(onData: (snapshot: SensorSnapshot) => void): () => void
}
```

建议用法：

- `getSnapshot()` 使用 HTTP 获取初始化数据。
- `subscribe()` 使用 WebSocket、ROS Bridge 或其他实时通道。
- `subscribe()` 必须返回取消订阅函数，供 React 组件卸载时清理连接。

## 6. Mock 与真实数据源切换

配置位置：`src/config/dataSource.ts`。

创建 `.env.local`：

```env
VITE_DATA_SOURCE=mock
VITE_API_BASE_URL=/api
VITE_WS_URL=ws://localhost:8080/ws
API_PORT=3001
AUTH_DB_PATH=data/auth.sqlite
NODE_ENV=development
```

说明：

- `VITE_DATA_SOURCE=mock`：使用 `src/services/mock.ts`。
- `VITE_DATA_SOURCE=real`：使用 `src/services/real.ts`。
- `VITE_API_BASE_URL`：未来业务 REST API 地址。
- `VITE_WS_URL`：未来传感器、训练或机器人实时状态 WebSocket 地址。
- `API_PORT`：本地认证服务端口。
- `AUTH_DB_PATH`：用户与会话数据库路径。

目前 `real.ts` 会明确抛出“真实数据适配器尚未接入”，因此在实现真实业务适配器前不要把业务数据源切换成 `real`。

服务选择发生在 `src/services/index.ts`：

```ts
export const services = {
  scene: mock ? mockSceneService : realSceneService,
  simulation: mock ? mockSimulationService : realSimulationService,
  training: mock ? mockTrainingService : realTrainingService,
  robot: mock ? mockRobotService : realRobotService,
  sensor: mock ? mockSensorService : realSensorService,
}
```

## 7. 接入真实后端的推荐步骤

1. 保持 `contracts.ts` 中的接口作为前后端边界。
2. 在 `real.ts` 中实现 REST 请求、响应校验和错误转换。
3. 将后端返回数据转换为 `src/types/index.ts` 中的类型。
4. 通过 `services/index.ts` 的统一出口提供给 store。
5. 在 `useAppStore.ts` 中增加异步 action 和加载、失败状态。
6. 组件只调用 store action，不直接依赖 URL、WebSocket 或具体适配器。
7. 完成真实适配器后，将 `.env.local` 的 `VITE_DATA_SOURCE` 改为 `real`。

建议为真实请求增加统一 HTTP 客户端，至少处理：

- 登录失效和 HTTP 401。
- 请求超时和取消。
- 服务端错误信息转换。
- 响应数据运行时校验。
- 请求 ID 和日志追踪。

## 8. 仿真、视频流和 ROS 接入位置

### 8.1 Three.js 或 Unity

替换位置：`src/components/SimulationView.tsx`。

保留组件的外部属性和 store 状态连接，只替换内部占位画面：

- Three.js：挂载 Canvas 和场景渲染器。
- Unity：挂载 Unity WebGL Canvas。
- 远程仿真：嵌入 WebRTC 或视频流播放器。

仿真开始、暂停、停止、重置和倍速指令应继续通过 `SimulationService` 发送。

### 8.2 视频流

可在 `SimulationView.tsx` 或传感器独立组件中加入：

- WebRTC：适合低延迟交互画面。
- HLS：适合单向监看，但延迟较高。
- MJPEG：接入简单，带宽使用较高。
- ROS Image Bridge：服务端完成 ROS Image 到浏览器协议转换。

组件内应维护连接状态、重连提示、加载状态和断流反馈，不能用静态图伪装成实时画面。

### 8.3 WebSocket 与 ROS

WebSocket 地址读取 `dataSourceConfig.wsUrl`。推荐按消息类型分发：

```ts
type RealtimeMessage =
  | { type: 'sensor'; payload: SensorSnapshot }
  | { type: 'robot'; payload: RobotState }
  | { type: 'training'; payload: TrainingMetrics }
  | { type: 'simulation-status'; payload: SimulationStatus }
```

ROS 不建议由浏览器直接控制真实机器人。推荐由后端网关连接 ROS/ROS2，并负责：

- Topic 订阅和消息转换。
- 控制指令鉴权。
- 指令频率限制。
- 急停和安全状态检查。
- 机器人离线与超时处理。

## 9. 当前本地交互与真实能力边界

以下操作当前只更新前端本地状态：

- 切换场景。
- 调整环境参数。
- 切换传感器标签。
- 暂停、继续、停止、重置仿真。
- 修改仿真倍速。
- 切换机器人控制模式。
- 动态模拟更新训练图表。

这些操作已经具备 UI 和状态流转，但还没有控制真实仿真引擎或机器人。后续接入时应把 store 中相应 action 改为调用统一服务层，并根据服务端结果提交状态。

## 10. 启动与验证

安装和启动：

```bash
npm install
npm run dev
```

`npm run dev` 会同时启动：

- Vite 前端开发服务器。
- Express 认证 API，默认端口 3001。

质量检查：

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

单独运行：

```bash
npm run dev:web
npm run dev:api
```

## 11. 生产部署注意事项

- 必须通过 HTTPS 提供服务。
- 设置 `NODE_ENV=production`，认证 Cookie 才会启用 `Secure`。
- 不要将 `data/auth.sqlite` 提交到 Git；当前 `data/` 已被忽略。
- SQLite 适合本地原型和单实例服务。多实例生产部署建议改用 PostgreSQL 或受管数据库。
- 应通过环境变量管理数据库连接、域名、Cookie 策略和允许的前端来源。
- 真实机器人控制接口必须增加角色权限和服务端授权，不能只依赖前端隐藏按钮。
- 建议增加密码重置、邮箱验证、管理员用户管理、审计日志、会话列表和主动下线能力。
- 上线前应补充 CSRF 策略、反向代理可信配置、结构化日志和完整接口集成测试。

## 12. 后续开发优先级建议

1. 实现场景和训练任务的真实 REST API。
2. 为 `real.ts` 增加统一 HTTP 客户端和响应校验。
3. 接入机器人、传感器和训练指标 WebSocket。
4. 将 `SimulationView` 替换为 Three.js、Unity 或真实视频流。
5. 增加用户角色、权限和操作审计。
6. 接入 ROS2 网关，并为机器人控制增加安全确认机制。
7. 添加端到端测试和断线、超时、重连场景测试。
