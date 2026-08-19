import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

const diagnostic = import.meta.env.DEV && (
  import.meta.env.VITE_D6_CHROMIUM_POC === '1'
  || new URLSearchParams(window.location.search).get('d6ChromiumPoc') === '1'
)
const root = createRoot(document.getElementById('root')!)
if (diagnostic) {
  void import('./diagnostics/ChromiumPocApp.tsx').then(({ ChromiumPocApp }) => {
    root.render(<StrictMode><ChromiumPocApp/></StrictMode>)
  })
} else {
  root.render(<StrictMode><App/></StrictMode>)
}
