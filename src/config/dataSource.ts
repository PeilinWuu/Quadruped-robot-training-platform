export type DataSource = 'mock' | 'real'

export const dataSourceConfig = {
  source: (import.meta.env.VITE_DATA_SOURCE ?? 'mock') as DataSource,
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? '/api',
  wsUrl: import.meta.env.VITE_WS_URL ?? 'ws://localhost:8080/ws',
}
