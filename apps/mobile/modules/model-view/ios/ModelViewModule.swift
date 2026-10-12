// Interactive glTF viewer behind the ```ui "model" widget. Downloads the model (GLB, or glTF with
// embedded buffers and images), converts it to a SceneKit scene with GLTFKit2, centers it, and puts
// a turntable camera rig at the distance that fits its bounding sphere. One-finger drag orbits the
// camera (pitch clamped short of the poles), pinch dollies within limits. `autoRotate` spins the
// model until the first touch. The drag claims touches before any enclosing scroll view, so orbiting
// inside the transcript does not scroll it.

import ExpoModulesCore
import GLTFKit2
import SceneKit
import UIKit

public class ModelViewModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ModelView")

    View(ModelSceneView.self) {
      Events("onLoad", "onError")

      Prop("src") { (view: ModelSceneView, src: String) in
        view.load(src)
      }

      Prop("autoRotate") { (view: ModelSceneView, autoRotate: Bool?) in
        view.autoRotate = autoRotate ?? false
      }
    }
  }
}

final class ModelSceneView: ExpoView, UIGestureRecognizerDelegate {
  let onLoad = EventDispatcher()
  let onError = EventDispatcher()

  var autoRotate = false {
    didSet { updateSpin() }
  }

  /// Vertical field of view, degrees: long enough to keep perspective mild on product shots.
  private static let fieldOfView: CGFloat = 30
  /// Breathing room around the bounding sphere at the fitted distance.
  private static let fitMargin: Float = 1.08
  /// Pinch range as multiples of the fitted distance.
  private static let zoomRange: ClosedRange<Float> = 0.35...3
  /// Orbit pitch limit, radians; stops short of the poles where yaw would flip.
  private static let pitchLimit: Float = 1.4
  /// Initial pitch: a little from above, so the model reads as standing on something.
  private static let restPitch: Float = -0.3
  /// Seconds per auto-rotate turn.
  private static let spinPeriod: TimeInterval = 16

  private let sceneView = SCNView(frame: .zero)
  private let turntable = SCNNode()
  private let orbit = SCNNode()
  private let camera = SCNNode()
  private var src: String?
  private var task: URLSessionDataTask?
  /// GLTFKit2's SceneKit bridge hands SceneKit index data that points into the asset's buffers
  /// without copying, so the asset must outlive the scene or the meshes draw from freed memory.
  private var asset: GLTFAsset?
  private var radius: Float = 0
  private var fitDistance: Float = 1
  private var distance: Float = 1
  private var pinchStartDistance: Float = 1
  private var yaw: Float = 0
  private var pitch: Float = ModelSceneView.restPitch
  private var touched = false

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true

    sceneView.backgroundColor = .clear
    sceneView.antialiasingMode = .multisampling4X
    sceneView.autoenablesDefaultLighting = false
    addSubview(sceneView)

    let lens = SCNCamera()
    lens.fieldOfView = Self.fieldOfView
    lens.automaticallyAdjustsZRange = true
    camera.camera = lens
    // Key light rides with the camera, raking from the upper left; the environment fills the rest.
    let key = SCNNode()
    key.light = SCNLight()
    key.light?.type = .directional
    key.light?.intensity = 800
    key.eulerAngles = SCNVector3(-0.5, -0.4, 0)
    camera.addChildNode(key)
    orbit.addChildNode(camera)

    let pan = UIPanGestureRecognizer(target: self, action: #selector(onPan(_:)))
    pan.maximumNumberOfTouches = 1
    pan.delegate = self
    let pinch = UIPinchGestureRecognizer(target: self, action: #selector(onPinch(_:)))
    pinch.delegate = self
    sceneView.addGestureRecognizer(pan)
    sceneView.addGestureRecognizer(pinch)
  }

  deinit {
    task?.cancel()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    sceneView.frame = bounds
    refit()
  }

  func load(_ src: String) {
    guard src != self.src else { return }
    self.src = src
    task?.cancel()
    sceneView.scene = nil
    asset = nil
    guard let url = URL(string: src), url.scheme == "http" || url.scheme == "https" else {
      fail(src, "This model link is not supported.")
      return
    }
    task = URLSession.shared.dataTask(with: url) { [weak self] data, response, error in
      if (error as? URLError)?.code == .cancelled { return }
      let ok = (response as? HTTPURLResponse).map { (200..<300).contains($0.statusCode) } ?? false
      guard let data, error == nil, ok else {
        DispatchQueue.main.async { self?.fail(src, "Could not download this model.") }
        return
      }
      let asset: GLTFAsset
      let scene: SCNScene
      do {
        asset = try GLTFAsset(data: data, options: [.createNormalsIfAbsentKey: true])
        scene = SCNScene(gltfAsset: asset)
      } catch {
        DispatchQueue.main.async { self?.fail(src, "Could not read this model.") }
        return
      }
      DispatchQueue.main.async { self?.show(scene, from: asset, for: src) }
    }
    task?.resume()
  }

  private func show(_ loaded: SCNScene, from asset: GLTFAsset, for src: String) {
    guard src == self.src else { return }
    self.asset = asset
    let model = SCNNode()
    for child in loaded.rootNode.childNodes {
      model.addChildNode(child)
    }
    guard let bounds = Self.geometryBounds(of: model) else {
      fail(src, "This model has nothing to show.")
      return
    }
    model.simdPosition = -(bounds.min + bounds.max) / 2
    radius = max(simd_length(bounds.max - bounds.min) / 2, .ulpOfOne)

    turntable.removeAllActions()
    turntable.childNodes.forEach { $0.removeFromParentNode() }
    turntable.eulerAngles = SCNVector3Zero
    turntable.addChildNode(model)

    let scene = SCNScene()
    scene.lightingEnvironment.contents = Self.environment
    scene.lightingEnvironment.intensity = 1.5
    scene.rootNode.addChildNode(turntable)
    // GLTFKit2's converted nodes never draw in this view (the same mesh on a plain SCNNode does),
    // so each mesh moves onto a fresh node with the same transform relative to `model`.
    var meshes: [SCNNode] = []
    model.enumerateHierarchy { node, _ in
      guard let geometry = node.geometry else { return }
      let fresh = SCNNode(geometry: geometry)
      fresh.simdTransform = node.simdConvertTransform(matrix_identity_float4x4, to: model)
      node.geometry = nil
      meshes.append(fresh)
    }
    meshes.forEach { model.addChildNode($0) }
    scene.rootNode.addChildNode(orbit)

    yaw = 0
    pitch = Self.restPitch
    touched = false
    distance = 0
    refit()
    sceneView.scene = scene
    sceneView.pointOfView = camera
    updateSpin()
    onLoad([:])
  }

  private func fail(_ src: String, _ message: String) {
    guard src == self.src else { return }
    onError(["message": message])
  }

  /// Distance at which the bounding sphere fits the narrower field of view; keeps the current zoom
  /// factor when the frame resizes.
  private func refit() {
    guard radius > 0, bounds.width > 0, bounds.height > 0 else { return }
    let vertical = Float(Self.fieldOfView) * .pi / 180 / 2
    let horizontal = atan(tan(vertical) * Float(bounds.width / bounds.height))
    let fitted = radius / sin(min(vertical, horizontal)) * Self.fitMargin
    distance = distance > 0 ? distance * fitted / fitDistance : fitted
    fitDistance = fitted
    applyCamera()
  }

  private func applyCamera() {
    orbit.eulerAngles = SCNVector3(pitch, yaw, 0)
    camera.position = SCNVector3(0, 0, distance)
  }

  private func updateSpin() {
    let key = "spin"
    if autoRotate, !touched, turntable.parent != nil {
      guard turntable.action(forKey: key) == nil else { return }
      turntable.runAction(.repeatForever(.rotateBy(x: 0, y: .pi * 2, z: 0, duration: Self.spinPeriod)), forKey: key)
    } else {
      turntable.removeAction(forKey: key)
    }
  }

  private func noteTouch() {
    guard !touched else { return }
    touched = true
    updateSpin()
  }

  @objc private func onPan(_ pan: UIPanGestureRecognizer) {
    guard radius > 0 else { return }
    if pan.state == .began { noteTouch() }
    let delta = pan.translation(in: sceneView)
    pan.setTranslation(.zero, in: sceneView)
    // A drag across the full width turns the model about one and a half half-turns.
    let perPoint = Float.pi * 1.5 / Float(max(sceneView.bounds.width, 1))
    yaw -= Float(delta.x) * perPoint
    pitch = min(max(pitch - Float(delta.y) * perPoint, -Self.pitchLimit), Self.pitchLimit)
    applyCamera()
  }

  @objc private func onPinch(_ pinch: UIPinchGestureRecognizer) {
    guard radius > 0, pinch.scale > 0 else { return }
    if pinch.state == .began {
      noteTouch()
      pinchStartDistance = distance
    }
    let range = Self.zoomRange
    distance = min(max(pinchStartDistance / Float(pinch.scale), fitDistance * range.lowerBound), fitDistance * range.upperBound)
    applyCamera()
  }

  // Orbiting wins over an enclosing scroll view: the scroll only starts if the drag fails.
  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool {
    other.view is UIScrollView
  }

  // Drag and pinch run together, so a pinch can drift into an orbit without lifting.
  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
    other.view === gestureRecognizer.view
  }

  /// Axis-aligned bounds of every mesh under `root`, in `root`'s space; nil when there is no geometry.
  private static func geometryBounds(of root: SCNNode) -> (min: SIMD3<Float>, max: SIMD3<Float>)? {
    var lo = SIMD3<Float>(repeating: .infinity)
    var hi = SIMD3<Float>(repeating: -.infinity)
    root.enumerateHierarchy { node, _ in
      guard let geometry = node.geometry else { return }
      let (a, b) = geometry.boundingBox
      for x in [a.x, b.x] {
        for y in [a.y, b.y] {
          for z in [a.z, b.z] {
            let p = node.convertPosition(SCNVector3(x, y, z), to: root)
            lo = simd_min(lo, SIMD3(p.x, p.y, p.z))
            hi = simd_max(hi, SIMD3(p.x, p.y, p.z))
          }
        }
      }
    }
    return lo.x.isFinite ? (lo, hi) : nil
  }

  /// Soft studio sky for image-based lighting: bright overhead, neutral horizon, dark floor.
  private static let environment: UIImage = {
    let size = CGSize(width: 512, height: 256)
    return UIGraphicsImageRenderer(size: size).image { context in
      let colors = [UIColor(white: 1, alpha: 1), UIColor(white: 0.72, alpha: 1), UIColor(white: 0.22, alpha: 1)]
      let gradient = CGGradient(
        colorsSpace: CGColorSpaceCreateDeviceRGB(),
        colors: colors.map(\.cgColor) as CFArray,
        locations: [0, 0.5, 1]
      )!
      context.cgContext.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: 0, y: size.height), options: [])
    }
  }()
}
