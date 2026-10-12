# GLTFKit2 0.5.15 (https://github.com/warrenm/GLTFKit2, tag 0.5.15, commit e69e354c, MIT) and the
# cgltf header it parses with (MIT), vendored as source. Upstream ships only an SPM binary
# xcframework: SwiftPM's artifact download stalls on a keychain prompt in headless builds, and the
# dynamic framework is not embedded when linked through a pod. Compiled here as a static framework
# instead. Left out: the RealityKit bridge (GLTFRealityKit.swift, GLTFAnimationHelpers.swift) and
# KTX2 textures (libktx), which compile out without <ktx.h>.
Pod::Spec.new do |s|
  s.name           = 'GLTFKit2'
  s.version        = '0.5.15'
  s.summary        = 'glTF 2.0 asset loading with SceneKit and Model I/O bridges'
  s.author         = 'Warren Moore'
  s.license        = { type: 'MIT', file: 'LICENSE' }
  s.homepage       = 'https://github.com/warrenm/GLTFKit2'
  s.platforms      = { :ios => '18.0' }
  s.source         = { git: 'https://github.com/warrenm/GLTFKit2.git', tag: '0.5.15' }
  s.static_framework = true
  s.requires_arc   = true

  s.frameworks = 'Metal', 'ModelIO', 'SceneKit', 'ImageIO', 'MobileCoreServices', 'UniformTypeIdentifiers'
  s.source_files = 'GLTFKit2/**/*.{h,m,mm}', 'cgltf/cgltf.h'
  s.public_header_files = 'GLTFKit2/*.h'
  # Upstream code, kept byte-for-byte: its deprecation and unused-variable warnings are not ours to fix.
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'GCC_WARN_INHIBIT_ALL_WARNINGS' => 'YES' }
end
