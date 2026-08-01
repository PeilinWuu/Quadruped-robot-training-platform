import { useGaussianViewer } from './useGaussianViewer'
import type { ViewerPhase } from './types'

const STATUS_LABELS: Record<ViewerPhase, string> = {
  initializing: '正在初始化 PlayCanvas',
  ready: 'PlayCanvas WebGL2 已就绪',
  unsupported: '当前浏览器/WebView 不支持 WebGL2',
  'context-lost': 'WebGL context 已丢失',
  failed: 'Viewer 初始化失败',
  'waiting-layout': '等待视口布局尺寸',
  fallback: 'PlayCanvas 初始化失败，当前仅运行 WebGL2 诊断',
  'scene-error': 'SOG 场景加载失败',
}

export function GaussianViewport() {
  const {
    containerRef,
    canvasRef,
    viewerState,
    reloadScene,
    unloadScene,
    resetCamera,
  } = useGaussianViewer()
  const { phase, status, message } = viewerState
  const backingWidth = status ? Math.floor(status.width * status.pixelRatio) : 0
  const backingHeight = status ? Math.floor(status.height * status.pixelRatio) : 0
  const scenePhase = status?.scenePhase ?? 'idle'
  const isBusy = scenePhase === 'fetching' || scenePhase === 'parsing' || scenePhase === 'unloading'
  const statusLabel = scenePhase === 'fetching'
    ? '正在读取 SOG'
    : scenePhase === 'parsing'
      ? '正在解析 SOG'
      : scenePhase === 'ready'
        ? 'SOG 场景已加载'
        : message ?? STATUS_LABELS[phase]

  return <div className={`gaussian-viewport gaussian-viewport--${phase}`} ref={containerRef}>
    <canvas className="gaussian-viewport__canvas" ref={canvasRef} aria-label="Gaussian Splatting viewport"/>
    <div className="gaussian-viewport__overlay">
      <strong className="gaussian-viewport__status">{statusLabel}</strong>
      <dl className="gaussian-viewport__metrics">
        <div><dt>Renderer</dt><dd>{status?.renderer ?? 'Initializing'}</dd></div>
        <div><dt>Backend</dt><dd>{status?.backend ?? '—'}</dd></div>
        <div><dt>Scene</dt><dd>{status?.sceneName ?? 'Not loaded'}</dd></div>
        <div><dt>Scene phase</dt><dd>{scenePhase}</dd></div>
        {typeof status?.progress === 'number'
          ? <div><dt>Progress</dt><dd>{Math.round(status.progress * 100)}%</dd></div>
          : null}
        <div><dt>CSS</dt><dd>{status?.width ?? 0} × {status?.height ?? 0}</dd></div>
        <div><dt>Backing store</dt><dd>{backingWidth} × {backingHeight}</dd></div>
        <div><dt>DPR</dt><dd>{status?.pixelRatio.toFixed(2) ?? '—'}</dd></div>
        <div><dt>Drawing</dt><dd>{status?.running ? 'Active' : 'Paused'}</dd></div>
        <div><dt>Viewer FPS</dt><dd>{status?.fps ?? 0}</dd></div>
        <div><dt>Fallback</dt><dd>{status?.fallback ? 'Yes' : 'No'}</dd></div>
      </dl>
      <small>
        {status?.fallback
          ? '诊断模式不支持 SOG 场景加载。'
          : 'FPS 仅表示 Viewer 绘制，不代表训练或仿真速度。'}
      </small>
    </div>
    <div className="gaussian-viewport__controls" aria-label="Gaussian viewer controls">
      <button type="button" onClick={reloadScene} disabled={isBusy}>重新加载</button>
      <button
        type="button"
        onClick={unloadScene}
        disabled={Boolean(status?.fallback) || scenePhase === 'idle' || scenePhase === 'unloading'}
      >
        卸载场景
      </button>
      <button
        type="button"
        onClick={resetCamera}
        disabled={Boolean(status?.fallback) || !status?.sceneLoaded}
      >
        重置视角
      </button>
    </div>
  </div>
}

export default GaussianViewport
