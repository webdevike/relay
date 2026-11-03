/**
 * The model widget's three.js scene, loaded on demand so three stays out of the main chunk:
 * a GLB (or self-contained glTF) lit by a neutral room environment, framed to fit, orbiting on
 * drag. The wheel scrolls the chat; a pinch (ctrl+wheel) zooms. A drag stops the turntable.
 */
import {
  ACESFilmicToneMapping,
  Box3,
  PerspectiveCamera,
  PMREMGenerator,
  SRGBColorSpace,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three'
import type { Material, Mesh } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'

export interface ModelOptions {
  autoRotate: boolean
  onLoad: () => void
  onError: (message: string) => void
}

/** Tilt stops this far short of straight up or down (radians). */
const POLE_MARGIN = 0.15
/** Distance limits as multiples of the framed distance. */
const ZOOM_MIN = 0.4
const ZOOM_MAX = 3

/** Mounts the viewer into `host` (sized by CSS) and returns its teardown. */
export function mountModel(host: HTMLElement, url: string, options: ModelOptions): () => void {
  let renderer: WebGLRenderer
  try {
    renderer = new WebGLRenderer({ antialias: true, alpha: true })
  } catch {
    options.onError('3D is unavailable')
    return () => {}
  }
  renderer.setPixelRatio(window.devicePixelRatio)
  renderer.outputColorSpace = SRGBColorSpace
  renderer.toneMapping = ACESFilmicToneMapping
  host.appendChild(renderer.domElement)

  const scene = new Scene()
  const pmrem = new PMREMGenerator(renderer)
  const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
  scene.environment = environment

  const camera = new PerspectiveCamera(35, 1, 0.01, 1000)
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.enablePan = false
  controls.enableZoom = false
  controls.minPolarAngle = POLE_MARGIN
  controls.maxPolarAngle = Math.PI - POLE_MARGIN
  controls.autoRotate = options.autoRotate
  controls.autoRotateSpeed = 1.5
  controls.addEventListener('start', () => {
    controls.autoRotate = false
  })

  let framed = 1
  const onWheel = (e: WheelEvent): void => {
    if (!e.ctrlKey) return
    e.preventDefault()
    const offset = camera.position.clone().sub(controls.target)
    const distance = Math.min(
      framed * ZOOM_MAX,
      Math.max(framed * ZOOM_MIN, offset.length() * Math.exp(e.deltaY * 0.01)),
    )
    camera.position.copy(controls.target).add(offset.setLength(distance))
  }
  renderer.domElement.addEventListener('wheel', onWheel, { passive: false })

  const resize = (): void => {
    const { clientWidth: w, clientHeight: h } = host
    if (w === 0 || h === 0) return
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }
  const observer = new ResizeObserver(resize)
  observer.observe(host)
  resize()

  let disposed = false
  new GLTFLoader()
    .loadAsync(url)
    .then((gltf) => {
      if (disposed) return
      const model = gltf.scene
      const box = new Box3().setFromObject(model)
      const size = box.getSize(new Vector3())
      const center = box.getCenter(new Vector3())
      model.position.sub(center)
      scene.add(model)
      const radius = Math.max(size.length() / 2, 1e-3)
      framed = radius / Math.sin((camera.fov * Math.PI) / 360)
      camera.near = framed / 100
      camera.far = framed * 100
      camera.position.set(framed * 0.6, framed * 0.35, framed * 0.75).setLength(framed)
      camera.updateProjectionMatrix()
      controls.target.set(0, 0, 0)
      controls.update()
      options.onLoad()
    })
    .catch(() => {
      if (!disposed) options.onError("Couldn't load model")
    })

  renderer.setAnimationLoop(() => {
    controls.update()
    renderer.render(scene, camera)
  })

  return () => {
    disposed = true
    renderer.setAnimationLoop(null)
    observer.disconnect()
    renderer.domElement.removeEventListener('wheel', onWheel)
    controls.dispose()
    scene.traverse((object) => {
      const mesh = object as Mesh
      mesh.geometry?.dispose()
      const materials = ([] as Material[]).concat(mesh.material ?? [])
      for (const material of materials) {
        for (const value of Object.values(material)) {
          if (value && typeof value === 'object' && 'isTexture' in value) value.dispose()
        }
        material.dispose()
      }
    })
    environment.dispose()
    pmrem.dispose()
    renderer.dispose()
    renderer.domElement.remove()
  }
}
