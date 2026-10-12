Pod::Spec.new do |s|
  s.name           = 'ModelView'
  s.version        = '1.0.0'
  s.summary        = 'Interactive glTF/GLB model view on SceneKit'
  s.description    = 'Downloads a GLB (or self-contained glTF), loads it with GLTFKit2 into SceneKit, frames it to fit, and orbits/zooms under touch.'
  s.author         = ''
  s.homepage       = 'https://github.com/warrenm/GLTFKit2'
  s.platforms      = { :ios => '18.0' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # Vendored next door in ../gltfkit2 (see its podspec); autolinked via expo-module.config.json.
  s.dependency 'GLTFKit2'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
