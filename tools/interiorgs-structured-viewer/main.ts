import {
  Application, Asset, Color, Entity, FILLMODE_FILL_WINDOW, RESOLUTION_AUTO,
  Texture, StandardMaterial, BLEND_NORMAL, BLEND_ADDITIVEALPHA, PIXELFORMAT_RGBA8, Vec3,
  Mesh, MeshInstance, ShaderMaterial, PRIMITIVE_POINTS, SEMANTIC_POSITION, SEMANTIC_COLOR,
} from 'playcanvas'

const BASE = '/scene'
const canvas = document.querySelector<HTMLCanvasElement>('#viewport')!
const status = document.querySelector<HTMLElement>('#status')!
const metrics = document.querySelector<HTMLElement>('#metrics')!
const category = document.querySelector<HTMLSelectElement>('#category')!
const selection = document.querySelector<HTMLElement>('#selection')!
const firePlay = document.querySelector<HTMLButtonElement>('#firePlay')!
const fireFocus = document.querySelector<HTMLButtonElement>('#fireFocus')!
const cleanView = document.querySelector<HTMLButtonElement>('#cleanView')!
const fireFrame = document.querySelector<HTMLInputElement>('#fireFrame')!
const fireReadout = document.querySelector<HTMLElement>('#fireReadout')!
const fireStats = document.querySelector<HTMLElement>('#fireStats')!

type Point = { x: number; y: number; z: number }
type Label = { ins_id: string; label: string; bounding_box?: Point[]; room_box?: Point[] }
type Occupancy = { scale: number; center: number[]; upper: number[]; lower: number[]; min: number[]; max: number[] }
type Room = { profile: Array<number[] | { x: number; y: number }> }
type Wall = { location: number[][]; thickness: number; height: number }
type Hole = { profile: Array<number[] | Point>; type: string }
type Structure = { rooms: Room[]; walls: Wall[]; holes: Hole[] }
type FireRoi = {
  selected_table_instance_id: string
  grid: { dimensions: number[]; voxel_size_m: number; lower: number[]; upper: number[]; center: number[] }
  ignition: { lower: number[]; upper: number[]; center: number[]; size: number[] }
  primary_combustible_instances: string[]
}
type FireManifest = {
  format: string; frames: number; fps: number; grid_size: number; voxel_size_m: number
  grid_lower: number[]; grid_upper: number[]; threshold: number; frame_counts: number[]; binary: string
}
type FireFrameIndex = { offset: number; count: number }

const colors = {
  box: new Color(1, .78, .24), room: new Color(.18, .95, .72),
  wall: new Color(.24, .58, 1), hole: new Color(1, .24, .38),
  roi: new Color(.67, .35, 1), ignition: new Color(1, .16, .05),
}

const layers = {
  occupancy: false, rooms: true, walls: true, holes: true, boxes: true, fireRoi: true, fire: true,
}
let labels: Label[] = []
let structure: Structure
let occupancy: Occupancy
let fireRoi: FireRoi
let selectedCategory = '__navigation__'
let occupancyEntity: Entity | null = null
let fireClouds: FireClouds | null = null
let fireManifest: FireManifest | null = null
let fireBytes: Uint8Array | null = null
let fireFrameIndex: FireFrameIndex[] = []
let currentFireFrame = 1
let firePlaying = true
let fireClock = 0

const app = new Application(canvas, {
  graphicsDeviceOptions: { antialias: false, powerPreference: 'high-performance' },
})
app.setCanvasFillMode(FILLMODE_FILL_WINDOW)
app.setCanvasResolution(RESOLUTION_AUTO)
app.graphicsDevice.maxPixelRatio = Math.min(devicePixelRatio, 1.5)
app.scene.ambientLight = new Color(.25, .25, .25)

const camera = new Entity('Camera', app)
camera.addComponent('camera', { clearColor: new Color(.025, .035, .045), nearClip: .2, farClip: 200, fov: 70 })
app.root.addChild(camera)

const orbit = { target: new Vec3(1, 1.3, 1), yaw: -90, pitch: 8.53, distance: 2.022 }
function applyCamera() {
  const yaw = orbit.yaw * Math.PI / 180
  const pitch = orbit.pitch * Math.PI / 180
  const horizontal = Math.cos(pitch) * orbit.distance
  camera.setPosition(
    orbit.target.x + Math.sin(yaw) * horizontal,
    orbit.target.y + Math.sin(pitch) * orbit.distance,
    orbit.target.z + Math.cos(yaw) * horizontal,
  )
  camera.lookAt(orbit.target, Vec3.UP)
}
applyCamera()

let dragging = false; let pan = false; let lastX = 0; let lastY = 0
canvas.addEventListener('pointerdown', (event) => {
  dragging = true; pan = event.button === 2 || event.shiftKey; lastX = event.clientX; lastY = event.clientY
  canvas.setPointerCapture(event.pointerId)
})
canvas.addEventListener('pointermove', (event) => {
  if (!dragging) return
  const dx = event.clientX - lastX; const dy = event.clientY - lastY; lastX = event.clientX; lastY = event.clientY
  if (pan) {
    const right = camera.right.clone().mulScalar(-dx * orbit.distance * .0015)
    const up = camera.up.clone().mulScalar(dy * orbit.distance * .0015)
    orbit.target.add(right).add(up)
  } else {
    orbit.yaw -= dx * .2; orbit.pitch = Math.max(-85, Math.min(85, orbit.pitch - dy * .2))
  }
  applyCamera()
})
canvas.addEventListener('pointerup', () => { dragging = false })
canvas.addEventListener('pointercancel', () => { dragging = false })
canvas.addEventListener('contextmenu', (event) => event.preventDefault())
canvas.addEventListener('wheel', (event) => {
  orbit.distance = Math.max(.15, Math.min(80, orbit.distance * Math.exp(event.deltaY * .001)))
  applyCamera(); event.preventDefault()
}, { passive: false })

// InteriorGS original: (x, y, z), Z-up. Viewer splat is rotated -90° around X:
// (x, y, z) -> (x, z, -y), giving PlayCanvas Y-up coordinates.
function world(point: Point | number[]): Vec3 {
  const x = Array.isArray(point) ? point[0] : point.x
  const y = Array.isArray(point) ? point[1] : point.y
  const z = Array.isArray(point) ? (point[2] ?? 0) : point.z
  return new Vec3(x, z, -y)
}
function p2(value: number[] | { x: number; y: number }): Vec3 {
  return Array.isArray(value) ? world([value[0], value[1], .025]) : world([value.x, value.y, .025])
}
function line(a: Vec3, b: Vec3, color: Color, depth = false) { app.drawLine(a, b, color, depth) }
function loop(points: Vec3[], color: Color) {
  for (let i = 0; i < points.length; i++) line(points[i], points[(i + 1) % points.length], color)
}
function box(points: Vec3[], color: Color) {
  if (points.length !== 8) return
  for (const [a, b] of [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]]) {
    line(points[a], points[b], color)
  }
}
function axisAlignedBox(lower: number[], upper: number[], color: Color) {
  const [x0,y0,z0] = lower; const [x1,y1,z1] = upper
  box([
    world([x0,y0,z0]), world([x0,y1,z0]), world([x1,y1,z0]), world([x1,y0,z0]),
    world([x0,y0,z1]), world([x0,y1,z1]), world([x1,y1,z1]), world([x1,y0,z1]),
  ], color)
}

const pointVertexShader = `
  attribute vec3 aPosition;
  attribute vec4 aColor;
  uniform mat4 matrix_model;
  uniform mat4 matrix_view;
  uniform mat4 matrix_projection;
  uniform float uPointScale;
  varying vec4 vColor;
  void main(void) {
    vec4 viewPosition = matrix_view * matrix_model * vec4(aPosition, 1.0);
    gl_Position = matrix_projection * viewPosition;
    gl_PointSize = clamp(uPointScale / max(0.05, -viewPosition.z), 2.0, 30.0);
    vColor = aColor;
  }
`
const pointFragmentShader = `
  precision highp float;
  varying vec4 vColor;
  void main(void) {
    vec2 centered = gl_PointCoord * 2.0 - 1.0;
    float radius2 = dot(centered, centered);
    if (radius2 > 1.0) discard;
    float falloff = exp(-2.4 * radius2) * smoothstep(1.0, 0.72, radius2);
    gl_FragColor = vec4(vColor.rgb * falloff, vColor.a * falloff);
  }
`

class PointCloud {
  readonly entity: Entity
  private readonly mesh: Mesh
  private readonly material: ShaderMaterial

  constructor(name: string, additive: boolean) {
    this.mesh = new Mesh(app.graphicsDevice)
    this.material = new ShaderMaterial({
      uniqueName: `FieryGS-${name}`,
      attributes: { aPosition: SEMANTIC_POSITION, aColor: SEMANTIC_COLOR },
      vertexGLSL: pointVertexShader,
      fragmentGLSL: pointFragmentShader,
    })
    this.material.blendType = additive ? BLEND_ADDITIVEALPHA : BLEND_NORMAL
    this.material.depthWrite = false
    this.material.setParameter('uPointScale', 12)
    this.material.update()
    const instance = new MeshInstance(this.mesh, this.material)
    instance.castShadow = false; instance.receiveShadow = false; instance.cull = false
    this.entity = new Entity(name, app)
    this.entity.addComponent('render', { meshInstances: [instance] })
    this.entity.enabled = false
    app.root.addChild(this.entity)
  }

  update(positions: Float32Array, colors: Uint8Array, pointScale: number) {
    if (positions.length === 0) { this.entity.enabled = false; return }
    this.mesh.setPositions(positions)
    this.mesh.setColors32(colors)
    this.mesh.update(PRIMITIVE_POINTS)
    this.material.setParameter('uPointScale', pointScale)
    this.entity.enabled = layers.fire
  }
}

class FireClouds {
  readonly flame = new PointCloud('FieryGS Flame', true)
  readonly smoke = new PointCloud('FieryGS Smoke', false)
  setEnabled(enabled: boolean) {
    this.flame.entity.enabled = enabled && this.flame.entity.enabled
    this.smoke.entity.enabled = enabled && this.smoke.entity.enabled
    if (enabled) renderFireFrame(currentFireFrame)
  }
}

function renderFireFrame(frame: number) {
  if (!fireManifest || !fireBytes || !fireClouds) return
  currentFireFrame = Math.max(0, Math.min(fireManifest.frames - 1, frame))
  const record = fireFrameIndex[currentFireFrame]
  const flamePositions: number[] = []; const flameColors: number[] = []
  const smokePositions: number[] = []; const smokeColors: number[] = []
  const lower = fireManifest.grid_lower; const size = fireManifest.voxel_size_m
  let flameCount = 0; let smokeCount = 0
  for (let i = 0; i < record.count; i++) {
    const offset = record.offset + i * 5
    const gx = fireBytes[offset]; const gy = fireBytes[offset + 1]; const gz = fireBytes[offset + 2]
    const temperature = fireBytes[offset + 3]; const fuel = fireBytes[offset + 4]
    const original = [lower[0] + (gx + .5) * size, lower[1] + (gy + .5) * size, lower[2] + (gz + .5) * size]
    const position = world(original)
    if (temperature >= 6) {
      const heat = temperature / 255
      flamePositions.push(position.x, position.y, position.z)
      flameColors.push(255, Math.min(255, 35 + Math.round(235 * heat)), Math.max(0, Math.round((heat - .58) * 300)), Math.min(118, 42 + Math.round(70 * heat)))
      flameCount++
    } else if (fuel >= 4) {
      const density = fuel / 255
      const grey = Math.round(55 + 45 * (1 - density))
      smokePositions.push(position.x, position.y, position.z)
      smokeColors.push(grey, grey + 4, grey + 8, Math.min(66, 12 + Math.round(50 * density)))
      smokeCount++
    }
  }
  const pixelFactor = canvas.height / (2 * Math.tan(camera.camera!.fov * Math.PI / 360))
  fireClouds.flame.update(new Float32Array(flamePositions), new Uint8Array(flameColors), size * pixelFactor * 1.15)
  fireClouds.smoke.update(new Float32Array(smokePositions), new Uint8Array(smokeColors), size * pixelFactor * 1.75)
  fireFrame.value = String(currentFireFrame)
  fireReadout.textContent = `帧 ${currentFireFrame + 1} / ${fireManifest.frames}`
  fireStats.textContent = `火焰 ${flameCount.toLocaleString()} · 烟雾 ${smokeCount.toLocaleString()} 个体素`
}

async function loadFireAnimation() {
  fireManifest = await fetch(`${BASE}/fire_preview/fire_manifest.json`).then((response) => response.json())
  const buffer = await fetch(`${BASE}/fire_preview/${fireManifest.binary}`).then((response) => response.arrayBuffer())
  fireBytes = new Uint8Array(buffer)
  const view = new DataView(buffer)
  if (String.fromCharCode(...fireBytes.slice(0, 4)) !== 'FGS1') throw new Error('火焰数据格式无效')
  const frames = view.getUint16(4, true)
  if (frames !== fireManifest.frames) throw new Error('火焰帧数与清单不一致')
  let offset = 12; fireFrameIndex = []
  for (let frame = 0; frame < frames; frame++) {
    const count = view.getUint32(offset, true); offset += 4
    fireFrameIndex.push({ offset, count }); offset += count * 5
  }
  if (offset !== buffer.byteLength) throw new Error('火焰数据长度不一致')
  fireClouds = new FireClouds()
  fireFrame.max = String(frames - 1)
  renderFireFrame(Math.min(10, frames - 1))
}

app.on('update', (dt) => {
  if (!structure) return
  if (firePlaying && fireManifest) {
    fireClock += dt
    if (fireClock >= 1 / fireManifest.fps) {
      fireClock %= 1 / fireManifest.fps
      renderFireFrame((currentFireFrame + 1) % fireManifest.frames)
    }
  }
  if (layers.rooms) for (const room of structure.rooms) loop(room.profile.map(p2), colors.room)
  if (layers.walls) for (const wall of structure.walls) {
    const [a0, b0] = wall.location.map((p) => world([p[0], p[1], .04]))
    const a1 = a0.clone(); const b1 = b0.clone(); a1.y = wall.height; b1.y = wall.height
    line(a0, b0, colors.wall); line(a1, b1, colors.wall); line(a0, a1, colors.wall); line(b0, b1, colors.wall)
  }
  if (layers.holes) for (const hole of structure.holes) loop(hole.profile.map((p) => world(p as Point | number[])), colors.hole)
  if (layers.boxes) {
    const chosen = labels.filter((item) => item.bounding_box && (
      selectedCategory === '__all__' ||
      selectedCategory === '__navigation__' && ['door', 'window'].includes(item.label.toLowerCase()) ||
      item.label === selectedCategory
    )).slice(0, 250)
    for (const item of chosen) box(item.bounding_box!.map(world), colors.box)
  }
  if (layers.fireRoi && fireRoi) {
    axisAlignedBox(fireRoi.grid.lower, fireRoi.grid.upper, colors.roi)
    axisAlignedBox(fireRoi.ignition.lower, fireRoi.ignition.upper, colors.ignition)
  }
})

function bindToggle(id: keyof typeof layers) {
  document.querySelector<HTMLInputElement>(`#${id}`)!.addEventListener('change', (event) => {
    layers[id] = (event.target as HTMLInputElement).checked
    if (id === 'occupancy' && occupancyEntity) occupancyEntity.enabled = layers.occupancy
    if (id === 'fire' && fireClouds) fireClouds.setEnabled(layers.fire)
  })
}
for (const id of Object.keys(layers) as Array<keyof typeof layers>) bindToggle(id)

function updateSelection() {
  const count = labels.filter((item) => item.bounding_box && (
    selectedCategory === '__all__' ||
    selectedCategory === '__navigation__' && ['door', 'window'].includes(item.label.toLowerCase()) ||
    item.label === selectedCategory
  )).length
  selection.textContent = `显示 ${Math.min(count, 250)} / ${count} 个带包围盒实例`
}
category.addEventListener('change', () => { selectedCategory = category.value; updateSelection() })
firePlay.addEventListener('click', () => {
  firePlaying = !firePlaying; firePlay.textContent = firePlaying ? '暂停' : '播放'
})
fireFrame.addEventListener('input', () => { firePlaying = false; firePlay.textContent = '播放'; renderFireFrame(Number(fireFrame.value)) })
fireFocus.addEventListener('click', () => {
  if (!fireRoi) return
  orbit.target.copy(world(fireRoi.ignition.center)); orbit.distance = 2.4; orbit.yaw = -125; orbit.pitch = 18; applyCamera()
})
cleanView.addEventListener('click', () => {
  for (const id of ['occupancy', 'rooms', 'walls', 'holes', 'boxes', 'fireRoi'] as const) {
    layers[id] = false
    document.querySelector<HTMLInputElement>(`#${id}`)!.checked = false
  }
  if (occupancyEntity) occupancyEntity.enabled = false
})

async function addOccupancyPlane() {
  const image = new Image(); image.src = `${BASE}/occupancy.png`; await image.decode()
  const texture = new Texture(app.graphicsDevice, { width: image.width, height: image.height, format: PIXELFORMAT_RGBA8 })
  texture.setSource(image)
  const material = new StandardMaterial()
  material.diffuseMap = texture; material.opacityMap = texture; material.opacity = .38
  material.blendType = BLEND_NORMAL; material.depthWrite = false; material.cull = 0; material.update()
  const entity = new Entity('Occupancy Map', app); entity.addComponent('render', { type: 'plane' })
  entity.setPosition(occupancy.center[0], .018, -occupancy.center[1])
  entity.setLocalScale(image.width * occupancy.scale, 1, image.height * occupancy.scale)
  entity.render!.meshInstances[0].material = material
  entity.enabled = layers.occupancy
  app.root.addChild(entity); occupancyEntity = entity
}

async function loadScene() {
  const asset = new Asset('office_01', 'gsplat', {
    url: `${BASE}/scene_yup.sog`, filename: 'scene.sog',
  })
  await new Promise<void>((resolve, reject) => {
    asset.once('load', () => resolve()); asset.once('error', reject)
    app.assets.add(asset); app.assets.load(asset)
  })
  const entity = new Entity('InteriorGS Scene', app)
  entity.addComponent('gsplat', { asset }); app.root.addChild(entity)
}

async function main() {
  status.textContent = '读取 GS、语义与结构数据…'
  const [labelData, occupancyData, structureData, fireRoiData] = await Promise.all([
    fetch(`${BASE}/labels.json`).then((r) => r.json()),
    fetch(`${BASE}/occupancy.json`).then((r) => r.json()),
    fetch(`${BASE}/structure.json`).then((r) => r.json()),
    fetch(`${BASE}/fire_roi.json`).then((r) => r.json()),
  ])
  labels = labelData; occupancy = occupancyData; structure = structureData; fireRoi = fireRoiData
  const counts = new Map<string, number>()
  for (const item of labels) counts.set(item.label, (counts.get(item.label) ?? 0) + 1)
  category.innerHTML = '<option value="__navigation__">门与窗（导航关键）</option><option value="__all__">全部类别（最多250框）</option>' +
    [...counts].sort((a,b) => b[1] - a[1]).map(([name,count]) => `<option value="${name.replaceAll('"','&quot;')}">${name} (${count})</option>`).join('')
  updateSelection()
  metrics.innerHTML = `<b>927,067</b> Gaussians<br><b>${labels.length}</b> 语义实例 / <b>${labels.filter(x=>x.bounding_box).length}</b> 包围盒<br>` +
    `<b>${structure.rooms.length}</b> 房间 · <b>${structure.walls.length}</b> 墙 · <b>${structure.holes.length}</b> 洞口<br>` +
    `占用图 <b>${occupancy.scale.toFixed(2)} m/px</b><br>` +
    `火焰 ROI <b>${fireRoi.grid.dimensions[0]}³</b> · 桌 ${fireRoi.selected_table_instance_id}`
  await Promise.all([loadScene(), addOccupancyPlane(), loadFireAnimation()])
  status.textContent = '已加载 · GS 与 FieryGS 体数据已统一为 Y-up 坐标'
}

main().catch((error) => { console.error(error); status.textContent = `加载失败：${String(error)}` })
app.start()
