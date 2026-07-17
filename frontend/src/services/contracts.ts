import type { EnvironmentParams, RobotState, Scene, SensorSnapshot, ServiceResult, TrainingMetrics, TrainingTask } from '../types'

// 服务契约是组件状态层与数据实现层的边界；Mock 和真实适配器必须遵守同一组类型。
export interface SceneService { list(): Promise<ServiceResult<Scene[]>>; get(id: string): Promise<ServiceResult<Scene>>; updateEnvironment(id: string, params: EnvironmentParams): Promise<ServiceResult<EnvironmentParams>> }
export interface SimulationService { start(): Promise<ServiceResult<void>>; pause(): Promise<ServiceResult<void>>; stop(): Promise<ServiceResult<void>>; reset(): Promise<ServiceResult<void>>; setSpeed(speed: number): Promise<ServiceResult<number>> }
export interface TrainingService { getTask(): Promise<ServiceResult<TrainingTask>>; getMetrics(): Promise<ServiceResult<TrainingMetrics[]>> }
export interface RobotService { getState(): Promise<ServiceResult<RobotState>>; setControlMode(mode: RobotState['controlMode']): Promise<ServiceResult<RobotState['controlMode']>> }
// subscribe 返回取消订阅函数，便于组件卸载时关闭 WebSocket 或 ROS 数据流。
export interface SensorService { getSnapshot(): Promise<ServiceResult<SensorSnapshot>>; subscribe(onData: (snapshot: SensorSnapshot) => void): () => void }
