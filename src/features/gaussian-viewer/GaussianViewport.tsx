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
    desktop,
    scenes,
    currentScene,
    libraryError,
    importState,
    importScene,
    cancelImport,
    selectScene,
    deleteScene,
    reloadScene,
    unloadScene,
    resetCamera,
    orientationBusy,
    rotateSceneOrientation,
    resetSceneOrientation,
    robotDesktop,
    robotPreview,
    toggleRobotVisible,
    focusRobot,
    setRobotCalibration,
    resetRobotCalibration,
    setRobotVisualMode,
    reloadRobotVisuals,
    environmentPreview,
    toggleEnvironmentVisible,
    toggleEnvironmentGrid,
    focusEnvironment,
  } = useGaussianViewer()
  const { phase, status, message } = viewerState
  const backingWidth = status ? Math.floor(status.width * status.pixelRatio) : 0
  const backingHeight = status ? Math.floor(status.height * status.pixelRatio) : 0
  const scenePhase = status?.scenePhase ?? 'idle'
  const isBusy = scenePhase === 'fetching' || scenePhase === 'parsing' || scenePhase === 'unloading'
  const importing = ['copying', 'validating', 'committing', 'cancelling'].includes(importState.phase)
  const canCancelImport = importState.operationId !== null
    && (importState.phase === 'copying' || importState.phase === 'validating')
  const importPercent = importState.progress && importState.progress.totalBytes > 0
    ? Math.round(importState.progress.bytesCopied / importState.progress.totalBytes * 100)
    : 0
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
    <aside className="robot-preview" aria-label="机器人显示调试">
      <details>
      <summary><strong>机器人显示调试</strong><span>D4E</span></summary>
      {!robotDesktop
        ? <p>机器人预览仅桌面版可用</p>
        : <>
            {robotPreview.error ? <p className="error">{robotPreview.error}</p> : null}
            {robotPreview.overlay?.modelId === 'unitree-go2-menagerie' ? <>
              <label className="robot-preview__visual-mode">当前视觉模式
                <select value={robotPreview.overlay.visual?.mode ?? 'official-mesh'} onChange={(event) => setRobotVisualMode(event.target.value as 'official-mesh' | 'primitive-debug')}>
                  <option value="official-mesh">Go2 官方网格</option>
                  <option value="primitive-debug">Go2 基础几何调试</option>
                </select>
              </label>
              <dl>
                <div><dt>网格状态</dt><dd>{robotPreview.overlay.visual?.phase ?? 'idle'}</dd></div>
                <div><dt>加载部件</dt><dd>{robotPreview.overlay.visual ? `${robotPreview.overlay.visual.loadedParts}/${robotPreview.overlay.visual.totalParts}` : '—'}</dd></div>
                <div><dt>读取字节</dt><dd>{robotPreview.overlay.visual ? `${robotPreview.overlay.visual.loadedBytes}/${robotPreview.overlay.visual.totalBytes}` : '—'}</dd></div>
              </dl>
            </> : <p>Minimal 模型仅支持基础几何</p>}
            <div className="robot-preview__actions">
              <button type="button" onClick={toggleRobotVisible}>{robotPreview.visible ? '隐藏机器人' : '显示机器人'}</button>
              <button type="button" onClick={focusRobot}>聚焦机器人</button>
              {robotPreview.overlay?.modelId === 'unitree-go2-menagerie' ? <button type="button" onClick={reloadRobotVisuals}>重新加载网格</button> : null}
            </div>
            <div className="environment-preview__summary">
              <strong>平地碰撞演示</strong>
              <span>{environmentPreview.halfExtent * 2} × {environmentPreview.halfExtent * 2} m · Y={environmentPreview.floorHeight}</span>
              <div className="robot-preview__actions">
                <button type="button" onClick={toggleEnvironmentVisible}>{environmentPreview.visible ? '隐藏平地' : '显示平地'}</button>
                <button type="button" onClick={toggleEnvironmentGrid}>{environmentPreview.gridVisible ? '隐藏网格线' : '显示网格线'}</button>
                <button type="button" onClick={focusEnvironment}>聚焦环境</button>
              </div>
            </div>
            <div className="robot-preview__calibration-wrap">
              <strong>内存校准</strong>
              <div className="robot-preview__calibration">
                {(['X', 'Y', 'Z'] as const).map((axis, index) => <label key={axis}>
                  {axis}
                  <input
                    type="number"
                    step="0.05"
                    value={robotPreview.calibration.translation[index]}
                    onChange={(event) => {
                      const translation = [...robotPreview.calibration.translation] as [number, number, number]
                      translation[index] = Number(event.target.value)
                      setRobotCalibration({ ...robotPreview.calibration, translation }, robotPreview.yawDegrees)
                    }}
                  />
                </label>)}
                <label>Yaw°<input
                  type="number"
                  step="5"
                  value={robotPreview.yawDegrees}
                  onChange={(event) => setRobotCalibration(robotPreview.calibration, Number(event.target.value))}
                /></label>
                <label>Scale<input
                  type="number"
                  min="0.1"
                  max="10"
                  step="0.1"
                  value={robotPreview.calibration.scale}
                  onChange={(event) => setRobotCalibration(
                    { ...robotPreview.calibration, scale: Number(event.target.value) },
                    robotPreview.yawDegrees,
                  )}
                /></label>
                <button type="button" onClick={resetRobotCalibration}>恢复默认</button>
              </div>
            </div>
          </>}
      </details>
    </aside>
    {desktop && currentScene ? <div
      className="gaussian-viewport__orientation-controls"
      aria-label="Scene orientation controls"
    >
      <span>场景朝向</span>
      <button type="button" onClick={() => rotateSceneOrientation('x', 90)} disabled={orientationBusy || isBusy || !status?.sceneLoaded}>X +90°</button>
      <button type="button" onClick={() => rotateSceneOrientation('y', 90)} disabled={orientationBusy || isBusy || !status?.sceneLoaded}>Y +90°</button>
      <button type="button" onClick={() => rotateSceneOrientation('z', 90)} disabled={orientationBusy || isBusy || !status?.sceneLoaded}>Z +90°</button>
      <button type="button" onClick={() => rotateSceneOrientation('x', 180)} disabled={orientationBusy || isBusy || !status?.sceneLoaded}>上下翻转</button>
      <button type="button" onClick={resetSceneOrientation} disabled={orientationBusy || isBusy || !status?.sceneLoaded}>恢复原始</button>
    </div> : null}
    <aside className="gaussian-viewport__library" aria-label="Local SOG scenes">
      <div className="gaussian-viewport__library-header">
        <strong>本地 SOG 场景</strong>
        {desktop
          ? <button type="button" onClick={() => void importScene()} disabled={importing || importState.phase === 'choosing'}>
              {importState.phase === 'choosing' ? '等待选择…' : '导入 SOG'}
            </button>
          : <span>仅桌面应用支持导入</span>}
      </div>
      {importing && <div className="gaussian-viewport__import-progress">
        <div><span>{importState.phase === 'copying' ? '复制' : importState.phase === 'validating' ? '验证' : importState.phase === 'committing' ? '提交' : '正在取消'}</span><b>{importPercent}%</b></div>
        <progress max="100" value={importPercent}/>
        <button type="button" onClick={() => void cancelImport()} disabled={!canCancelImport}>取消导入</button>
      </div>}
      {(importState.message || importState.error || libraryError) && <p className={importState.error || libraryError ? 'error' : ''}>
        {importState.error ?? libraryError ?? importState.message}
      </p>}
      {desktop && scenes.length === 0
        ? <div className="gaussian-viewport__empty">尚未导入场景</div>
        : <div className="gaussian-viewport__scene-list">
            {scenes.map((scene) => <div className={scene.id === currentScene?.id ? 'current' : ''} key={scene.id}>
              <button type="button" onClick={() => void selectScene(scene.id)} disabled={importing}>
                <strong>{scene.displayName}</strong>
                <small>{formatBytes(scene.byteSize)} · {formatTime(scene.importedAt)} · {scene.sha256.slice(0, 10)}</small>
              </button>
              <button
                type="button"
                className="danger"
                disabled={importing}
                onClick={() => {
                  if (window.confirm(`确认删除场景“${scene.displayName}”？`)) void deleteScene(scene.id)
                }}
                aria-label={`删除 ${scene.displayName}`}
              >删除</button>
            </div>)}
          </div>}
    </aside>
  </div>
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default GaussianViewport
