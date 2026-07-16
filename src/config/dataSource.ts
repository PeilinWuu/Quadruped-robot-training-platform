export type DataSource = 'mock' | 'real'

// 所有业务连接地址集中在这里，组件不能直接读取环境变量或写死接口地址。
export const dataSourceConfig = {
  source: (import.meta.env.VITE_DATA_SOURCE ?? 'mock') as DataSource,
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? '/api',
  wsUrl: import.meta.env.VITE_WS_URL ?? 'ws://localhost:8080/ws',
}
