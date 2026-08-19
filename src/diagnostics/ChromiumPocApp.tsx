import { useEffect } from 'react'
import { App as AntApp, ConfigProvider, theme } from 'antd'
import { RobotPanel } from '../components/RobotPanel'
import { startD6ChromiumWorkload } from './chromiumWorkload'
import '../App.css'

function diagnosticMode(): 'dynamic' | 'static' {
  const query = new URLSearchParams(window.location.search).get('mode')
  if (query === 'static') return 'static'
  return import.meta.env.VITE_D6_CHROMIUM_POC_MODE === 'static' ? 'static' : 'dynamic'
}

export function ChromiumPocApp() {
  const mode = diagnosticMode()
  useEffect(() => startD6ChromiumWorkload(mode), [mode])
  return <ConfigProvider theme={{ algorithm: theme.darkAlgorithm, token: {
    colorPrimary: '#18a8df', colorBgBase: '#07131d', colorText: '#b9cad6', borderRadius: 2,
    fontFamily: 'Inter, "Microsoft YaHei", system-ui, sans-serif',
  } }}><AntApp><main className="d6-chromium-poc">
    <header><strong>D6 Chromium Runtime A/B POC</strong><span>RobotPanel production component · telemetry {mode}</span></header>
    <RobotPanel diagnostic/>
  </main></AntApp></ConfigProvider>
}
