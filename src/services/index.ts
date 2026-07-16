import { dataSourceConfig } from '../config/dataSource'
import { mockRobotService, mockSceneService, mockSensorService, mockSimulationService, mockTrainingService } from './mock'
import { realRobotService, realSceneService, realSensorService, realSimulationService, realTrainingService } from './real'

const mock = dataSourceConfig.source === 'mock'
// 组件和 store 只从本统一出口取服务，因此切换数据源不需要修改页面组件。
export const services = {
  scene: mock ? mockSceneService : realSceneService,
  simulation: mock ? mockSimulationService : realSimulationService,
  training: mock ? mockTrainingService : realTrainingService,
  robot: mock ? mockRobotService : realRobotService,
  sensor: mock ? mockSensorService : realSensorService,
}
export type { SceneService, SimulationService, TrainingService, RobotService, SensorService } from './contracts'
