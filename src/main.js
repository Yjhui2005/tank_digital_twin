import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
// 导入MediaPipe手势识别（使用 side-effect 导入，实际实例从 window.Hands / window.Camera 获取）
import '@mediapipe/hands'
import '@mediapipe/camera_utils'

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
  cruiseSpeed: 8,
  keys: { KeyW: false, KeyA: false, KeyS: false, KeyD: false, KeyQ: false, KeyE: false }
}
const SENSITIVITY_PRESETS = {
  low:  { deadZone: 0.05, steerGain: 2.2, throttleGain: 1.8, lerp: 0.55, speedScale: 0.75, motionDiff: 5,  minCount: 12 },
  mid:  { deadZone: 0.08, steerGain: 1.6, throttleGain: 1.25, lerp: 0.45, speedScale: 0.6,  motionDiff: 6,  minCount: 18 },
  high: { deadZone: 0.12, steerGain: 1.0, throttleGain: 0.8,  lerp: 0.30, speedScale: 0.4,  motionDiff: 8,  minCount: 28 }
}

// 手势动捕核心对象（替换原有鼠标动捕）
const motionCapture = {
  enabled: false,
  stream: null,
  video: null,
  hands: null,
  mpCamera: null,
  throttle: 0,
  steer: 0,
  confidence: 0,
  sensitivity: 'mid',
  gestureState: '待机',
  steerState: 'center'
}
const vehicleState = {
  velocity: 0,
  maxForwardSpeed: 10,
  maxReverseSpeed: 4,
  acceleration: 12,
  brakeDeceleration: 20,
  idleDrag: 10,
  steerRate: 1.9,
  collision: false
}

let lastTime = 0
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
    if (child.name === 'track_L') {
      track_L = child
      initTrackTexture(track_L)
    }
    if (child.name === 'track_R') {
      track_R = child
      initTrackTexture(track_R)
    }
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

// 辅助函数：初始化履带纹理包裹模式，防止滚动时拉伸卡死
function initTrackTexture(mesh) {
  if (mesh.material) {
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    materials.forEach(mat => {
      if (mat.map) {
        mat.map.wrapS = THREE.RepeatWrapping
        mat.map.wrapT = THREE.RepeatWrapping
      }
    })
  }
}

// 键盘控制
document.addEventListener('keydown', (e) => {
  if (e.code in tankControl.keys) tankControl.keys[e.code] = true
})
document.addEventListener('keyup', (e) => {
  if (e.code in tankControl.keys) tankControl.keys[e.code] = false
})
window.addEventListener('blur', () => {
  for (const key of Object.keys(tankControl.keys)) tankControl.keys[key] = false
})

// ====================== 全新手势控制UI（彻底替换旧的鼠标动捕UI）======================
function setupMotionCaptureUI() {
  const panel = document.createElement('div')
  panel.className = 'vision-panel'
  panel.innerHTML = `
    <div class="vision-title">MediaPipe手势动捕</div>
    <button id="vision-toggle" class="vision-btn">启用手势控制</button>
    <div id="vision-state" class="vision-state">状态：未启用（手掌控制）</div>
    <div id="vision-gesture" class="vision-gesture">手势：待机</div>
    <div id="vision-turn" class="vision-turn">转向：直行</div>
    <div class="vision-sensitivity">
      <span>灵敏度：</span>
      <div class="vision-btns">
        <button class="sens-btn" data-sens="low">低</button>
        <button class="sens-btn sens-active" data-sens="mid">中</button>
        <button class="sens-btn" data-sens="high">高</button>
      </div>
    </div>
    <div class="vision-sens-hint" id="vision-sens-hint">当前：中灵敏度（推荐）</div>
    <video id="vision-video" class="vision-video" autoplay muted playsinline></video>
  `
  document.body.appendChild(panel)

  motionCapture.video = panel.querySelector('#vision-video')
  const stateEl = panel.querySelector('#vision-state')
  const gestureEl = panel.querySelector('#vision-gesture')
  const turnEl = panel.querySelector('#vision-turn')
  const toggleBtn = panel.querySelector('#vision-toggle')

  const updateVisionStatus = () => {
    if (!stateEl || !gestureEl || !turnEl) return
    if (!motionCapture.enabled) {
      stateEl.textContent = '状态：已关闭'
      gestureEl.textContent = '手势：待机'
      turnEl.textContent = '转向：直行'
      return
    }

    if (motionCapture.confidence < 0.01) {
      stateEl.textContent = '状态：手势待识别'
    } else {
      stateEl.textContent = `状态：${motionCapture.gestureState}`
    }
    gestureEl.textContent = `手势：${motionCapture.gestureState}`
    turnEl.textContent = `转向：${motionCapture.steerState === 'left' ? '左转' : motionCapture.steerState === 'right' ? '右转' : '直行'}`
  }

  toggleBtn.addEventListener('click', async () => {
    if (motionCapture.enabled) {
      stopMotionCapture()
      stateEl.textContent = '状态：已关闭'
      toggleBtn.textContent = '启用手势控制'
      motionCapture.gestureState = '待机'
      motionCapture.steerState = 'center'
      motionCapture.updateVisionStatus?.()
      return
    }

    try {
      stateEl.textContent = '状态：正在初始化MediaPipe...'
      console.log('【调试】点击启用手势控制按钮')
      await initHandTracking();
      motionCapture.enabled = true
      stateEl.textContent = '状态：识别中（手掌/握拳）'
      toggleBtn.textContent = '关闭手势控制'
      motionCapture.updateVisionStatus?.()
      console.log('【调试】手势控制启用成功')
    } catch (error) {
      console.error('【错误】手势初始化失败:', error)
      stateEl.textContent = '状态：初始化失败'
      alert('手势初始化失败！请按F12打开控制台查看详细错误信息：\n' + error.message)
    }
  })

  const hintEl = panel.querySelector('#vision-sens-hint')
  const SENS_HINTS = {
    low: '低灵敏度（防误触）',
    mid: '中灵敏度（推荐）',
    high: '高灵敏度（响应快）'
  }

  panel.querySelectorAll('.sens-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const sens = btn.dataset.sens
      motionCapture.sensitivity = sens
      panel.querySelectorAll('.sens-btn').forEach(b => b.classList.remove('sens-active'))
      btn.classList.add('sens-active')
      hintEl.textContent = `当前：${SENS_HINTS[sens]}`
      motionCapture.updateVisionStatus?.()
    })
  })

  motionCapture.updateVisionStatus = updateVisionStatus
}

// ====================== 带详细调试的MediaPipe初始化（使用国内CDN）======================
async function initHandTracking() {
  console.log('【调试】开始初始化MediaPipe手势识别...');
  
  const HandsCtor = window.Hands
  const CameraCtor = window.Camera
  if (!HandsCtor || !CameraCtor) {
    throw new Error('MediaPipe Hands 或 Camera 未正确加载，请检查依赖是否已安装或 CDN 是否可访问')
  }

  const hands = new HandsCtor({
    locateFile: (file) => {
      // 使用国内CDN加速，解决加载失败问题
      const url = `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1646424915/${file}`;
      console.log('【调试】加载MediaPipe模型:', url);
      return url;
    }
  });

  hands.setOptions({
    maxNumHands: 1,
    modelComplexity: 0, // 使用最轻量模型，速度最快
    minDetectionConfidence: 0.4, // 降低置信度，提高识别率
    minTrackingConfidence: 0.4
  });

  hands.onResults((results) => {
    console.log('【调试】收到手势识别结果，检测到', results.multiHandLandmarks.length, '只手');
    onHandResults(results);
  });

  motionCapture.hands = hands;

  // 检查浏览器兼容性
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('您的浏览器不支持摄像头API，请使用Chrome/Edge/Firefox浏览器');
  }

  // 检查安全上下文（摄像头要求 HTTPS 或 localhost）
  const isSecureContext = window.isSecureContext || location.protocol === 'https:'
  const isLocalhost = /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
  if (!isSecureContext && !isLocalhost) {
    throw new Error('当前页面不是安全上下文，摄像头访问被浏览器阻止。请通过 https:// 或 localhost 访问此页面，或在外部浏览器中打开。')
  }

  // 先请求摄像头权限
  console.log('【调试】请求摄像头权限...');
  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 320, height: 240, facingMode: 'user' },
      audio: false
    })
  } catch (err) {
    if (err && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')) {
      throw new Error('摄像头权限被拒绝，请允许摄像头访问并刷新页面。')
    }
    if (err && err.name === 'NotFoundError') {
      throw new Error('未检测到摄像头，请检查设备是否连接。')
    }
    throw new Error('获取摄像头失败：' + (err && err.message ? err.message : err))
  }

  motionCapture.video.srcObject = stream;
  motionCapture.stream = stream;
  console.log('【调试】摄像头权限获取成功');

  // 等待视频加载完成
  await new Promise((resolve) => {
    motionCapture.video.onloadedmetadata = resolve;
  });
  console.log('【调试】视频流加载完成');

  const mpCamera = new CameraCtor(motionCapture.video, {
    onFrame: async () => {
      if (motionCapture.enabled && motionCapture.hands) {
        try {
          await hands.send({ image: motionCapture.video });
        } catch (e) {
          console.error('【错误】帧处理失败:', e);
        }
      }
    },
    width: 320,
    height: 240
  });
  
  await mpCamera.start();
  motionCapture.mpCamera = mpCamera;
  console.log('【调试】MediaPipe手势识别初始化完成！');
}

// ====================== 带详细调试的手势识别逻辑 ======================
function onHandResults(results) {
  // 每次检测前重置所有状态
  motionCapture.throttle = 0;
  motionCapture.steer = 0;
  motionCapture.confidence = 0;

  if (results.multiHandLandmarks.length === 0) {
    console.log('【调试】未检测到手');
    return;
  }

  motionCapture.confidence = 1;
  const landmarks = results.multiHandLandmarks[0];
  const wrist = landmarks[0];
  console.log('【调试】检测到手！手腕位置: x=', wrist.x.toFixed(2), 'y=', wrist.y.toFixed(2));

  const fingerPairs = [
    { tip: 8, pip: 6 },
    { tip: 12, pip: 10 },
    { tip: 16, pip: 14 },
    { tip: 20, pip: 18 }
  ];

  const extendedFingers = fingerPairs.reduce((count, pair) => {
    return count + (landmarks[pair.tip].y < landmarks[pair.pip].y ? 1 : 0);
  }, 0);

  const isFist = extendedFingers <= 1;
  const steerThresholds = { low: 0.18, mid: 0.12, high: 0.08 }
  const openPalmThresholds = { low: 4, mid: 3, high: 2 }
  const steerThreshold = steerThresholds[motionCapture.sensitivity] || 0.12
  const openThreshold = openPalmThresholds[motionCapture.sensitivity] || 3
  const isOpenPalm = extendedFingers >= openThreshold

  motionCapture.gestureState = isOpenPalm ? '张开手掌' : isFist ? '握拳' : '未识别'
  motionCapture.throttle = isOpenPalm ? 1 : 0

  console.log('【调试】伸展手指数量:', extendedFingers, '握拳:', isFist, '张开手掌:', isOpenPalm);
  if (isOpenPalm) {
    console.log('【调试】执行：前进（张开手掌）');
  } else if (isFist) {
    console.log('【调试】执行：停止（握拳）');
  } else {
    console.log('【调试】执行：停止（手势不明确）');
  }

  const handCenterX = (wrist.x + landmarks[5].x + landmarks[9].x) / 3
  console.log('【调试】手掌水平中心:', handCenterX.toFixed(3), '阈值:', steerThreshold.toFixed(2))
  console.log('【调试】手掌水平中心:', handCenterX.toFixed(3), '阈值:', steerThreshold.toFixed(2))

  if (handCenterX < 0.5 - steerThreshold) {
    motionCapture.steer = -1
    motionCapture.steerState = 'left'
    console.log('【调试】执行：左转')
  } else if (handCenterX > 0.5 + steerThreshold) {
    motionCapture.steer = 1
    motionCapture.steerState = 'right'
    console.log('【调试】执行：右转')
  } else {
    motionCapture.steer = 0
    motionCapture.steerState = 'center'
    console.log('【调试】执行：直行')
  }

  motionCapture.updateVisionStatus?.()
}

// ====================== 停止动捕（完整清理资源）======================
function stopMotionCapture() {
  console.log('【调试】停止手势控制');
  if (motionCapture.mpCamera) {
    try {
      motionCapture.mpCamera.stop();
    } catch (e) {
      console.error('【错误】停止摄像头失败:', e);
    }
  }
  if (motionCapture.hands) {
    try {
      motionCapture.hands.close();
    } catch (e) {
      console.error('【错误】关闭MediaPipe失败:', e);
    }
  }
  if (motionCapture.stream) {
    motionCapture.stream.getTracks().forEach(track => track.stop());
  }
  motionCapture.enabled = false;
  motionCapture.throttle = 0;
  motionCapture.steer = 0;
  motionCapture.confidence = 0;
  motionCapture.video.srcObject = null;
}

// ====================== 动捕更新（兼容原有坦克逻辑）======================
function updateMotionCapture() {
  // 手势识别已在回调中处理，此处仅占位兼容原有代码
}

// ====================== 以下代码完全不变，保留你的所有功能 ======================
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

    if (tmpSize.x < 0.2 || tmpSize.y < 0.2 || tmpSize.z < 0.2) return
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

// 坦克运动
function updateTank(delta) {
  if (!tank) return
  updateMotionCapture()

  if (tankControl.keys.KeyE) tankControl.cruiseSpeed = Math.min(22, tankControl.cruiseSpeed + 6 * delta)
  if (tankControl.keys.KeyQ) tankControl.cruiseSpeed = Math.max(6, tankControl.cruiseSpeed - 6 * delta)

  const keyThrottle = (tankControl.keys.KeyW ? 1 : 0) - (tankControl.keys.KeyS ? 1 : 0)
  const keySteer = (tankControl.keys.KeyA ? 1 : 0) - (tankControl.keys.KeyD ? 1 : 0)
  const useVision = motionCapture.enabled && motionCapture.confidence > 0.0015
  const preset = SENSITIVITY_PRESETS[motionCapture.sensitivity]
  let throttleInput = useVision ? motionCapture.throttle * preset.speedScale : keyThrottle
  let steerInput = useVision ? motionCapture.steer * 0.8 : keySteer

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

  const speedFactor = THREE.MathUtils.clamp(Math.abs(vehicleState.velocity) / 8, 0.2, 1)
  const steering = steerInput * vehicleState.steerRate * speedFactor * delta
  if (Math.abs(vehicleState.velocity) > 0.05 || steerInput !== 0) {
    tank.rotation.y += steering * (vehicleState.velocity < 0 ? -1 : 1)
  }

  tankForward.set(0, 0, -1).applyQuaternion(tank.quaternion)
  candidatePos.copy(tank.position).addScaledVector(tankForward, vehicleState.velocity * delta)
  candidatePos.y = getGroundHeight(candidatePos.x, candidatePos.z, tank.position.y)

  const lookaheadDistance = Math.max(tankCollisionRadius + 0.5, Math.abs(vehicleState.velocity) * 0.4 + tankCollisionRadius)
  const lookaheadPos = tmpCenter.copy(tank.position).addScaledVector(tankForward, lookaheadDistance)
  lookaheadPos.y = getGroundHeight(lookaheadPos.x, lookaheadPos.z, tank.position.y)

  const blockedAhead = wouldHitObstacle(lookaheadPos)
  const blocked = blockedAhead || wouldHitObstacle(candidatePos)
  vehicleState.collision = blocked
  if (!blocked) {
    tank.position.copy(candidatePos)
  } else {
    vehicleState.velocity = 0
  }

  const signedSteer = steerInput * (vehicleState.velocity < 0 ? -1 : 1)
  const trackTurnFactor = signedSteer * Math.min(Math.abs(vehicleState.velocity), 6) * 0.45
  const leftTrackLinear = vehicleState.velocity - trackTurnFactor
  const rightTrackLinear = vehicleState.velocity + trackTurnFactor
  const leftWheelSpin = leftTrackLinear * delta * 14
  const rightWheelSpin = rightTrackLinear * delta * 14

  for (const w of wheelsLeft) w.rotation.x += leftWheelSpin
  for (const w of wheelsRight) w.rotation.x += rightWheelSpin
  if (!wheelsLeft.length && !wheelsRight.length) {
    for (const w of wheels) w.rotation.x += vehicleState.velocity * delta * 14
  }

  if (track_L?.material?.map) {
    track_L.material.map.offset.y += leftWheelSpin * 0.08
  }
  if (track_R?.material?.map) {
    track_R.material.map.offset.y += rightWheelSpin * 0.08
  }

  updateHUD(throttleInput, steerInput)
}

// 相机跟随
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

// HUD面板
function createHUD() {
  const panel = document.createElement('div')
  panel.className = 'hud-panel'
  panel.innerHTML = `
    <div class="hud-title">履带小车运行面板</div>
    <div class="hud-row"><span>速度</span><strong id="hud-speed">0.0 km/h</strong></div>
    <div class="hud-row"><span>航向</span><strong id="hud-heading">0°</strong></div>
    <div class="hud-row"><span>巡航上限</span><strong id="hud-cruise">12.0 m/s</strong></div>
    <div class="hud-row"><span>状态</span><strong id="hud-state">待机</strong></div>
    <div class="hud-help">W/S 前进后退 · A/D 转向 · 张开手掌前进 · 握拳停止 · 手掌左右移动转向</div>
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
  else if (motionCapture.enabled && motionCapture.confidence > 0.003) {
    hud.state.textContent = `手势：${motionCapture.gestureState}${motionCapture.steerState === 'center' ? '' : ' / ' + (motionCapture.steerState === 'left' ? '左转' : '右转')}`
  } else if (motionCapture.enabled) hud.state.textContent = '手势待识别'
  else if (throttleInput !== 0) hud.state.textContent = '推进中'
  else if (steerInput !== 0) hud.state.textContent = '转向中'
  else if (Math.abs(vehicleState.velocity) > 0.15) hud.state.textContent = '滑行'
  else hud.state.textContent = '待机'
}

// 主循环
function animate(time) {
  requestAnimationFrame(animate)
  const now = time || performance.now()
  const delta = lastTime ? THREE.MathUtils.clamp((now - lastTime) / 1000, 1 / 240, 0.05) : 1 / 60
  lastTime = now
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
tip.innerHTML = '手动驾驶模式：W/S 控制推进，A/D 控制转向，Q/E 调整动力上限 | 手势：张开手掌前进，握拳停止，左右移动转向'
document.body.appendChild(tip)