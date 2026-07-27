import { useGaussianViewer } from './useGaussianViewer'
import type { ViewerPhase } from './types'

const STATUS_LABELS: Record<ViewerPhase, string> = {
  initializing: '正在初始化 GPU 视口',
  ready: 'WebGL2 视口已就绪，GS Renderer 尚未接入',
  unsupported: '当前浏览器/WebView 不支持 WebGL2',
  'context-lost': 'WebGL context 已丢失',
  failed: 'Viewer 初始化失败',
  'waiting-layout': '等待视口布局尺寸',
}

export function GaussianViewport() {
  const { containerRef, canvasRef, viewerState } = useGaussianViewer()
  const { phase, status, message } = viewerState
  const backingWidth = status ? Math.floor(status.width * status.pixelRatio) : 0
  const backingHeight = status ? Math.floor(status.height * status.pixelRatio) : 0

  return <div className={`gaussian-viewport gaussian-viewport--${phase}`} ref={containerRef}>
    <canvas className="gaussian-viewport__canvas" ref={canvasRef} aria-label="Gaussian Splatting viewport"/>
    <div className="gaussian-viewport__overlay">
      <strong className="gaussian-viewport__status">{message ?? STATUS_LABELS[phase]}</strong>
      <dl className="gaussian-viewport__metrics">
        <div><dt>CSS</dt><dd>{status?.width ?? 0} × {status?.height ?? 0}</dd></div>
        <div><dt>Backing store</dt><dd>{backingWidth} × {backingHeight}</dd></div>
        <div><dt>DPR</dt><dd>{status?.pixelRatio.toFixed(2) ?? '—'}</dd></div>
        <div><dt>Backend</dt><dd>WebGL2 Probe</dd></div>
        <div><dt>Test loop</dt><dd>{status?.running ? 'Running' : 'Paused'}</dd></div>
        <div><dt>Canvas test FPS</dt><dd>{status?.fps ?? 0}</dd></div>
        <div><dt>GS scene</dt><dd>Not loaded</dd></div>
      </dl>
      <small>诊断信息仅验证 Canvas/WebGL2；当前不是 GS 渲染结果。</small>
    </div>
  </div>
}

export default GaussianViewport
