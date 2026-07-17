import type { RobotService, SceneService, SensorService, SimulationService, TrainingService } from './contracts'
import type { EnvironmentParams, RobotState, Scene, SensorSnapshot, TrainingMetrics, TrainingTask } from '../types'

// 这些数据只用于界面开发和演示，不代表真实仿真或机器人返回值。
export const scenes: Scene[] = [
  { id: 'office', name: '办公楼_3F_走廊火灾', building: '综合办公楼', area: 1200, floor: '3F', fireLocation: '东侧走廊与会议室', risk: '高', description: '烟气快速扩散，走廊存在多处临时障碍。', environment: { fireIntensity: 68, smokeDensity: 65, ambientTemp: 62, obstacleDensity: 32 } },
  { id: 'residential', name: '居民楼_2F_卧室火灾', building: '高层住宅 B 座', area: 860, floor: '2F', fireLocation: '次卧及门厅', risk: '中', description: '空间狭窄，房门与家具形成复杂搜索路径。', environment: { fireIntensity: 52, smokeDensity: 48, ambientTemp: 48, obstacleDensity: 45 } },
  { id: 'garage', name: '地下车库_车辆火灾', building: '地下停车区', area: 2600, floor: 'B1', fireLocation: 'C 区 18 号车位', risk: '高', description: '低照度、大空间，存在车辆遮挡与高温烟羽。', environment: { fireIntensity: 82, smokeDensity: 72, ambientTemp: 71, obstacleDensity: 58 } },
  { id: 'mall', name: '商场_中庭火灾', building: '商业综合体', area: 3400, floor: '1F', fireLocation: '中庭临时展台', risk: '中', description: '开放式空间，多出口与动态障碍物。', environment: { fireIntensity: 58, smokeDensity: 42, ambientTemp: 52, obstacleDensity: 38 } },
]

const robot: RobotState = { battery: 78, cpuTemp: 56, jointStatus: '正常', gait: '小跑', position: [23.5, 14.2, 0.28], speed: 0.85, controlMode: 'autonomous' }
const sensor: SensorSnapshot = { temperature: 62.3, smoke: 0.65, visibility: 3.8, co: 45, oxygen: 18.6, wind: 0.6 }
const task: TrainingTask = { id: 'search-01', name: '搜索目标并返回营地', description: '在火灾环境中搜索模拟被困人员，避开危险区域和障碍物，并安全返回起始点。', status: '训练中', progress: 62, currentReward: 256.8, elapsed: 765, duration: 1200, episode: 806, maxEpisodes: 1300 }

const wait = <T>(data: T) => Promise.resolve({ data, source: 'mock' as const })
export const mockSceneService: SceneService = { list: () => wait(scenes), get: (id) => wait(scenes.find((item) => item.id === id) ?? scenes[0]), updateEnvironment: (_id, params: EnvironmentParams) => wait(params) }
export const mockSimulationService: SimulationService = { start: () => wait(undefined), pause: () => wait(undefined), stop: () => wait(undefined), reset: () => wait(undefined), setSpeed: (speed) => wait(speed) }
export const mockTrainingService: TrainingService = { getTask: () => wait(task), getMetrics: () => wait(Array.from({ length: 36 }, (_, index): TrainingMetrics => ({ episode: index * 35, reward: -110 + index * 11 + Math.sin(index * 1.7) * 28, successRate: Math.min(96, 8 + index * 2.55 + Math.sin(index) * 6), policyLoss: Math.max(.008, .82 * Math.exp(-index / 7) + Math.random() * .025), valueLoss: Math.max(.01, .55 * Math.exp(-index / 9) + Math.random() * .035) }))) }
export const mockRobotService: RobotService = { getState: () => wait(robot), setControlMode: (mode) => wait(mode) }
// 定时抖动用于演示实时刷新；接入后应由真实 SensorService 数据流替换。
export const mockSensorService: SensorService = { getSnapshot: () => wait(sensor), subscribe: (onData) => { const timer = window.setInterval(() => onData({ ...sensor, temperature: +(sensor.temperature + (Math.random() - .5) * 1.2).toFixed(1), smoke: +(sensor.smoke + (Math.random() - .5) * .03).toFixed(2) }), 2500); return () => window.clearInterval(timer) } }
