import type { EnvironmentParams, RobotState, Scene, SensorSnapshot, ServiceResult, TrainingMetrics, TrainingTask } from '../types'

export interface SceneService { list(): Promise<ServiceResult<Scene[]>>; get(id: string): Promise<ServiceResult<Scene>>; updateEnvironment(id: string, params: EnvironmentParams): Promise<ServiceResult<EnvironmentParams>> }
export interface SimulationService { start(): Promise<ServiceResult<void>>; pause(): Promise<ServiceResult<void>>; stop(): Promise<ServiceResult<void>>; reset(): Promise<ServiceResult<void>>; setSpeed(speed: number): Promise<ServiceResult<number>> }
export interface TrainingService { getTask(): Promise<ServiceResult<TrainingTask>>; getMetrics(): Promise<ServiceResult<TrainingMetrics[]>> }
export interface RobotService { getState(): Promise<ServiceResult<RobotState>>; setControlMode(mode: RobotState['controlMode']): Promise<ServiceResult<RobotState['controlMode']>> }
export interface SensorService { getSnapshot(): Promise<ServiceResult<SensorSnapshot>>; subscribe(onData: (snapshot: SensorSnapshot) => void): () => void }
