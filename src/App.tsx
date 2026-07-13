import { App as AntApp, ConfigProvider, message, Spin, theme } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { Header } from './components/Header'
import { SceneSidebar } from './components/SceneSidebar'
import { SimulationView } from './components/SimulationView'
import { SensorPanel } from './components/SensorPanel'
import { MapPanel } from './components/MapPanel'
import { TrainingPanel } from './components/TrainingPanel'
import { ChartsPanel } from './components/ChartsPanel'
import { RobotPanel } from './components/RobotPanel'
import { StatusBar } from './components/StatusBar'
import { AuthScreen } from './components/AuthScreen'
import { authService, type AuthUser } from './services/authService'
import { useAppStore } from './store/useAppStore'
import './App.css'

function Dashboard({ user, onLogout }: { user: AuthUser; onLogout: () => void }) {
  const [messageApi, holder] = message.useMessage()
  const { initialize, tick, appendMetrics } = useAppStore()
  const notify = useCallback((text: string) => void messageApi.info(text), [messageApi])
  useEffect(() => { void initialize().catch((error: unknown) => messageApi.error(error instanceof Error ? error.message : '数据初始化失败')) }, [initialize, messageApi])
  useEffect(() => {
    const clock = window.setInterval(tick, 1000); const metrics = window.setInterval(appendMetrics, 2500)
    const reserved = (event: Event) => notify(`${(event as CustomEvent<string>).detail}接口已预留，等待后端接入`)
    window.addEventListener('reserved-action', reserved)
    return () => { window.clearInterval(clock); window.clearInterval(metrics); window.removeEventListener('reserved-action', reserved) }
  }, [appendMetrics, notify, tick])
  return <div className="app-shell">{holder}<Header user={user} onLogout={onLogout}/><main className="dashboard"><SceneSidebar notify={notify}/><div className="center-column"><SimulationView notify={notify}/><div className="lower-row"><TrainingPanel notify={notify}/><ChartsPanel/></div></div><aside className="right-column"><SensorPanel/><MapPanel/><RobotPanel notify={notify}/></aside></main><StatusBar displayName={user.displayName}/></div>
}

function AuthenticatedApp() {
  const [user, setUser] = useState<AuthUser | null>(null); const [checking, setChecking] = useState(true); const [messageApi, holder] = message.useMessage()
  useEffect(() => { authService.me().then(({ user: current }) => setUser(current)).catch(() => setUser(null)).finally(() => setChecking(false)) }, [])
  const logout = async () => { try { await authService.logout(); setUser(null); messageApi.success('已安全退出登录') } catch (error) { messageApi.error(error instanceof Error ? error.message : '退出失败') } }
  if (checking) return <div className="auth-loading">{holder}<Spin size="large"/><span>正在验证安全会话…</span></div>
  return <>{holder}{user ? <Dashboard user={user} onLogout={() => void logout()}/> : <AuthScreen onAuthenticated={setUser}/>}</>
}

export default function App() { return <ConfigProvider theme={{ algorithm: theme.darkAlgorithm, token: { colorPrimary: '#18a8df', colorBgBase: '#07131d', colorText: '#b9cad6', borderRadius: 2, fontFamily: 'Inter, "Microsoft YaHei", system-ui, sans-serif' }, components: { Button: { defaultBg: '#0d2231', defaultBorderColor: '#20445c' }, Segmented: { itemSelectedBg: '#16415a' } } }}><AntApp><AuthenticatedApp/></AntApp></ConfigProvider> }
