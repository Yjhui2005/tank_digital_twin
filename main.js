// 直接使用 CDN 地址，让浏览器能直接找到 Three.js 引擎
import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';
import { GLTFLoader } from 'https://unpkg.com/three@0.160.0/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'https://unpkg.com/three@0.160.0/examples/jsm/controls/OrbitControls.js';

//import './style.css'

// 基础场景
const scene = new THREE.Scene()
scene.background = new THREE.Color(0x1a1a1a)

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 2000)
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.setPixelRatio(window.devicePixelRatio)
document.body.appendChild(renderer.domElement)
camera.position.set(0, 12, 22)

// 鼠标控制全开：旋转 / 缩放 / 平移
const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true
controls.dampingFactor = 0.08
controls.enableRotate = true
controls.enableZoom = true
controls.enablePan = true
controls.zoomSpeed = 0.8
controls.minDistance = 5
controls.maxDistance = 300

// 灯光
const ambientLight = new THREE.AmbientLight(0xffffff, 1)
scene.add(ambientLight)
const dirLight = new THREE.DirectionalLight(0xffffff, 1.8)
dirLight.position.set(50, 80, 50)
scene.add(dirLight)

// 坦克部件
let tank = null
let track_L = null
let track_R = null
let wheels = []
let wheelsLeft = []
let wheelsRight = []
const terrainGroundMeshes = []
const staticObstacleBoxes = []

// 坦克控制与状态
const tankControl = {
  cruiseSpeed: 12,
  keys: { KeyW: false, KeyA: false, KeyS: false, KeyD: false, KeyQ: false, KeyE: false }
}
const motionCapture = {
  enabled: false,
  stream: null,
  video: null,
  canvas: null,
  ctx: null,
  prevGray: null,
  throttle: 0,
  steer: 0,
  confidence: 0,
  speedScale: 0.6
}
const vehicleState = {
  velocity: 0,
  maxForwardSpeed: 20,
  maxReverseSpeed: 8,
  acceleration: 18,
  brakeDeceleration: 28,
  idleDrag: 8,
  steerRate: 1.9,
  collision: false
}

const timer = new THREE.Timer()
let hasCameraInitialized = false
const tankGroundOffset = 0.8
const tankCollisionRadius = 2.1

// 复用对象，避免每帧分配内存
const tankForward = new THREE.Vector3()
const candidatePos = new THREE.Vector3()
const rayOrigin = new THREE.Vector3()
const rayDirection = new THREE.Vector3(0, -1, 0)
const clampPoint = new THREE.Vector3()
const raycaster = new THREE.Raycaster()
const tmpSize = new THREE.Vector3()
const tmpCenter = new THREE.Vector3()
const tankLocalPos = new THREE.Vector3()

const hud = createHUD()
setupMotionCaptureUI()

// 加载场景
const sceneLoader = new GLTFLoader()
sceneLoader.load('./Terrain.glb', (gltf) => {
  const terrain = gltf.scene
  scene.add(terrain)
  buildTerrainPhysics(terrain)
})

// 加载坦克
const tankLoader = new GLTFLoader()
tankLoader.load('./tank.glb', (gltf) => {
  tank = gltf.scene
  tank.scale.set(5, 5, 5)
  tank.position.set(0, 0.75, 0)
  scene.add(tank)

  // 抓取你命名的履带
  tank.traverse((child) => {
    if (child.name === 'track_L') track_L = child
    if (child.name === 'track_R') track_R = child
    // 收集车轮（只让车轮转，车身不转）
    if (child.isMesh && child.name.toLowerCase().includes('wheel')) {
      wheels.push(child)
      child.getWorldPosition(tankLocalPos)
      tank.worldToLocal(tankLocalPos)
      if (tankLocalPos.x < 0) wheelsLeft.push(child)
      else wheelsRight.push(child)
    }
  })
})

// 键盘
document.addEventListener('keydown', (e) => {
  if (e.code in tankControl.keys) tankControl.keys[e.code] = true
})
document.addEventListener('keyup', (e) => {
  if (e.code in tankControl.keys) tankControl.keys[e.code] = false
})
window.addEventListener('blur', () => {
  for (const key of Object.keys(tankControl.keys)) tankControl.keys[key] = false
})

function setupMotionCaptureUI() {
  const panel = document.createElement('div')
  panel.className = 'vision-panel'
  panel.innerHTML = `
    <div class="vision-title">YOYO白色鼠标动捕</div>
    <button id="vision-toggle" class="vision-btn">启用摄像头动捕</button>
    <div id="vision-state" class="vision-state">状态：未启用（识别白色鼠标）</div>
    <video id="vision-video" class="vision-video" autoplay muted playsinline></video>
  `
  document.body.appendChild(panel)

  const offscreenCanvas = document.createElement('canvas')
  offscreenCanvas.width = 160
  offscreenCanvas.height = 120

  motionCapture.video = panel.querySelector('#vision-video')
  motionCapture.canvas = offscreenCanvas
  motionCapture.ctx = offscreenCanvas.getContext('2d', { willReadFrequently: true })

  const stateEl = panel.querySelector('#vision-state')
  const toggleBtn = panel.querySelector('#vision-toggle')

  toggleBtn.addEventListener('click', async () => {
    if (motionCapture.enabled) {
      stopMotionCapture()
      stateEl.textContent = '状态：已关闭'
      toggleBtn.textContent = '启用摄像头动捕'
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: 'environment' },
        audio: false
      })
      motionCapture.stream = stream
      motionCapture.video.srcObject = stream
      motionCapture.enabled = true
      motionCapture.prevGray = null
      stateEl.textContent = '状态：识别中（白色鼠标）'
      toggleBtn.textContent = '关闭动捕'
    } catch (error) {
      console.error('摄像头权限失败:', error)
      stateEl.textContent = '状态：摄像头权限失败'
    }
  })
}

function stopMotionCapture() {
  if (motionCapture.stream) {
    for (const track of motionCapture.stream.getTracks()) track.stop()
  }
  motionCapture.enabled = false
  motionCapture.stream = null
  motionCapture.video.srcObject = null
  motionCapture.throttle = 0
  motionCapture.steer = 0
  motionCapture.confidence = 0
  motionCapture.prevGray = null
}

function updateMotionCapture() {
  if (!motionCapture.enabled || !motionCapture.video || !motionCapture.ctx) return
  if (motionCapture.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return

  const { canvas, ctx, video } = motionCapture
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const pixels = image.data

  let sumX = 0
  let sumY = 0
  let count = 0
  const totalPixels = canvas.width * canvas.height
  const grayNow = new Uint8Array(totalPixels)
  const step = 2

  for (let py = 0; py < canvas.height; py += step) {
    for (let px = 0; px < canvas.width; px += step) {
      const pixelId = py * canvas.width + px
      const i = pixelId * 4
      const r = pixels[i]
      const g = pixels[i + 1]
      const b = pixels[i + 2]

      const gray = (r * 77 + g * 150 + b * 29) >> 8
      grayNow[pixelId] = gray

      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      const delta = max - min
      const sat = max === 0 ? 0 : delta / max
      const val = max / 255

      // 白色鼠标：低饱和 + 高亮度
      const isWhite = sat < 0.2 && val > 0.62

      // 结合帧间差分，过滤静态白墙
      let isMoving = true
      if (motionCapture.prevGray) {
        const prev = motionCapture.prevGray[pixelId]
        isMoving = Math.abs(gray - prev) > 6
      }

      if (!isWhite || !isMoving) continue
      sumX += px
      sumY += py
      count++
    }
  }

  motionCapture.prevGray = grayNow

  const sampledPixels = Math.ceil(canvas.width / step) * Math.ceil(canvas.height / step)
  motionCapture.confidence = count / sampledPixels

  if (count < 18) {
    motionCapture.throttle = 0
    motionCapture.steer = 0
    return
  }

  const cx = sumX / count
  const cy = sumY / count
  const nx = (cx / canvas.width) * 2 - 1
  const ny = (cy / canvas.height) * 2 - 1
  const deadZone = 0.08

  // 速度降低：动捕输入本身减弱
  const steer = Math.abs(nx) > deadZone ? THREE.MathUtils.clamp(nx * 1.6, -1, 1) : 0
  const throttle = Math.abs(ny) > deadZone ? THREE.MathUtils.clamp(-ny * 1.25, -1, 1) : 0

  motionCapture.steer = THREE.MathUtils.lerp(motionCapture.steer, steer, 0.45)
  motionCapture.throttle = THREE.MathUtils.lerp(motionCapture.throttle, throttle, 0.45)
}

function buildTerrainPhysics(terrainRoot) {
  terrainRoot.updateMatrixWorld(true)

  terrainRoot.traverse((child) => {
    if (!child.isMesh || !child.geometry) return

    const meshBox = new THREE.Box3().setFromObject(child)
    if (meshBox.isEmpty()) return

    meshBox.getSize(tmpSize)
    meshBox.getCenter(tmpCenter)

    const name = child.name.toLowerCase()
    const area = tmpSize.x * tmpSize.z
    const lowAndWide = tmpSize.y < 2 && area > 120
    const nameLooksGround = /terrain|ground|road|street|floor|plane|land|grass|lane/.test(name)
    const isGroundCandidate = nameLooksGround || lowAndWide

    if (isGroundCandidate) {
      terrainGroundMeshes.push(child)
      return
    }

    // 小碎片跳过，减少无效碰撞体
    if (tmpSize.x < 0.2 || tmpSize.y < 0.2 || tmpSize.z < 0.2) return

    // 给障碍物增加轻微缓冲，避免擦边穿模
    staticObstacleBoxes.push(meshBox.clone().expandByScalar(0.35))
  })
}

function getGroundHeight(x, z, fallbackY) {
  if (!terrainGroundMeshes.length) return fallbackY

  rayOrigin.set(x, 200, z)
  raycaster.set(rayOrigin, rayDirection)

  const hit = raycaster.intersectObjects(terrainGroundMeshes, false)[0]
  if (!hit) return fallbackY
  return hit.point.y + tankGroundOffset
}

function wouldHitObstacle(position) {
  for (const box of staticObstacleBoxes) {
    box.clampPoint(position, clampPoint)
    if (clampPoint.distanceToSquared(position) < tankCollisionRadius * tankCollisionRadius) {
      return true
    }
  }
  return false
}

// 坦克运动：加速/减速/惯性/防撞
function updateTank(delta) {
  if (!tank) return
  updateMotionCapture()

  // 速度调节
  if (tankControl.keys.KeyE) tankControl.cruiseSpeed = Math.min(22, tankControl.cruiseSpeed + 6 * delta)
  if (tankControl.keys.KeyQ) tankControl.cruiseSpeed = Math.max(6, tankControl.cruiseSpeed - 6 * delta)

  const keyThrottle = (tankControl.keys.KeyW ? 1 : 0) - (tankControl.keys.KeyS ? 1 : 0)
  const keySteer = (tankControl.keys.KeyA ? 1 : 0) - (tankControl.keys.KeyD ? 1 : 0)
  const useVision = motionCapture.enabled && motionCapture.confidence > 0.0015
  let throttleInput = useVision ? motionCapture.throttle * motionCapture.speedScale : keyThrottle
  let steerInput = useVision ? motionCapture.steer * 0.8 : keySteer

  // 纵向动力学：油门、刹车、空挡阻尼
  if (throttleInput !== 0) {
    const sameDirection = vehicleState.velocity === 0 || Math.sign(vehicleState.velocity) === Math.sign(throttleInput)
    const accel = sameDirection ? vehicleState.acceleration : vehicleState.brakeDeceleration
    vehicleState.velocity += throttleInput * accel * delta
  } else {
    const drag = vehicleState.idleDrag * delta
    if (Math.abs(vehicleState.velocity) <= drag) vehicleState.velocity = 0
    else vehicleState.velocity -= Math.sign(vehicleState.velocity) * drag
  }

  const cruiseLimit = useVision ? Math.min(tankControl.cruiseSpeed, 6) : tankControl.cruiseSpeed
  vehicleState.velocity = THREE.MathUtils.clamp(
    vehicleState.velocity,
    -vehicleState.maxReverseSpeed,
    Math.min(vehicleState.maxForwardSpeed, cruiseLimit)
  )

  // 转向强度随速度变化：静止能原地轻微转向，行驶更稳定
  const speedFactor = THREE.MathUtils.clamp(Math.abs(vehicleState.velocity) / 8, 0.2, 1)
  const steering = steerInput * vehicleState.steerRate * speedFactor * delta
  if (Math.abs(vehicleState.velocity) > 0.05 || steerInput !== 0) {
    tank.rotation.y += steering * (vehicleState.velocity < 0 ? -1 : 1)
  }

  // 预测位移 + 碰撞阻挡
  tankForward.set(0, 0, -1).applyQuaternion(tank.quaternion)
  candidatePos.copy(tank.position).addScaledVector(tankForward, vehicleState.velocity * delta)
  candidatePos.y = getGroundHeight(candidatePos.x, candidatePos.z, tank.position.y)

  const blocked = wouldHitObstacle(candidatePos)
  vehicleState.collision = blocked
  if (!blocked) {
    tank.position.copy(candidatePos)
  } else {
    vehicleState.velocity *= 0.2
  }

  // 左右履带差速：转向时左右速度不同，更像真实履带车
  const signedSteer = steerInput * (vehicleState.velocity < 0 ? -1 : 1)
  const trackTurnFactor = signedSteer * Math.min(Math.abs(vehicleState.velocity), 6) * 0.45
  const leftTrackLinear = vehicleState.velocity - trackTurnFactor
  const rightTrackLinear = vehicleState.velocity + trackTurnFactor
  const leftWheelSpin = leftTrackLinear * delta * 14
  const rightWheelSpin = rightTrackLinear * delta * 14

  // 车轮分左右旋转
  for (const w of wheelsLeft) w.rotation.x += leftWheelSpin
  for (const w of wheelsRight) w.rotation.x += rightWheelSpin
  // 模型没有左右轮命名时兜底
  if (!wheelsLeft.length && !wheelsRight.length) {
    for (const w of wheels) w.rotation.x += vehicleState.velocity * delta * 14
  }

  // 履带纹理差速滚动
  if (track_L?.material?.map) {
    track_L.material.map.wrapT = THREE.RepeatWrapping
    track_L.material.map.offset.y += leftWheelSpin * 0.08
  }
  if (track_R?.material?.map) {
    track_R.material.map.wrapT = THREE.RepeatWrapping
    track_R.material.map.offset.y += rightWheelSpin * 0.08
  }

  updateHUD(throttleInput, steerInput)
}

// 相机平滑跟随（偏俯视）
function updateCameraFollow() {
  if (!tank) return
  if (!hasCameraInitialized) {
    camera.position.copy(tank.position).add(new THREE.Vector3(0, 15, 20))
    hasCameraInitialized = true
  }

  const followOffset = new THREE.Vector3(0, 10, 18).applyAxisAngle(new THREE.Vector3(0, 1, 0), tank.rotation.y)
  const desiredPos = tank.position.clone().add(followOffset)
  camera.position.lerp(desiredPos, 0.08)
  controls.target.lerp(tank.position, 0.12)
}

function createHUD() {
  const panel = document.createElement('div')
  panel.className = 'hud-panel'
  panel.innerHTML = `
    <div class="hud-title">履带小车运行面板</div>
    <div class="hud-row"><span>速度</span><strong id="hud-speed">0.0 km/h</strong></div>
    <div class="hud-row"><span>航向</span><strong id="hud-heading">0°</strong></div>
    <div class="hud-row"><span>巡航上限</span><strong id="hud-cruise">12.0 m/s</strong></div>
    <div class="hud-row"><span>状态</span><strong id="hud-state">待机</strong></div>
    <div class="hud-help">W/S 前进后退 · A/D 转向 · Q/E 调速</div>
  `
  document.body.appendChild(panel)

  return {
    speed: panel.querySelector('#hud-speed'),
    heading: panel.querySelector('#hud-heading'),
    cruise: panel.querySelector('#hud-cruise'),
    state: panel.querySelector('#hud-state')
  }
}

function updateHUD(throttleInput, steerInput) {
  const speedKmh = Math.abs(vehicleState.velocity) * 3.6
  const headingDeg = THREE.MathUtils.euclideanModulo(THREE.MathUtils.radToDeg(tank.rotation.y), 360)

  hud.speed.textContent = `${speedKmh.toFixed(1)} km/h`
  hud.heading.textContent = `${headingDeg.toFixed(0)}°`
  hud.cruise.textContent = `${tankControl.cruiseSpeed.toFixed(1)} m/s`

  if (vehicleState.collision) hud.state.textContent = '碰撞预警'
  else if (motionCapture.enabled && motionCapture.confidence > 0.003) hud.state.textContent = '动捕跟随中'
  else if (motionCapture.enabled) hud.state.textContent = '动捕待识别'
  else if (throttleInput !== 0) hud.state.textContent = '推进中'
  else if (steerInput !== 0) hud.state.textContent = '转向中'
  else if (Math.abs(vehicleState.velocity) > 0.15) hud.state.textContent = '滑行'
  else hud.state.textContent = '待机'
}

// 主循环
function animate() {
  requestAnimationFrame(animate)
  timer.update()
  const delta = THREE.MathUtils.clamp(timer.getDelta() || 1 / 60, 1 / 240, 0.05)
  updateTank(delta)
  updateCameraFollow()
  controls.update()
  renderer.render(scene, camera)
}
animate()

// 窗口适配
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
})

// 顶部提示
const tip = document.createElement('div')
tip.className = 'hud-tip'
tip.innerHTML = '手动驾驶模式：W/S 控制推进，A/D 控制转向，Q/E 调整动力上限'
document.body.appendChild(tip)