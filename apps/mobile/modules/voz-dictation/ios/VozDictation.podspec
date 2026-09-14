require 'json'

Pod::Spec.new do |s|
  s.name           = 'VozDictation'
  s.version        = '1.0.0'
  s.summary        = 'Hold-to-talk speech recognition with Desert Ant Voz (Parakeet on the Neural Engine)'
  s.description    = 'Records the microphone while the finger is down and transcribes the clip on device with Voz.'
  s.author         = ''
  s.homepage       = 'https://desertant.com/models/voz/'
  s.platforms      = { :ios => '18.0' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  # Voz ships as a Swift package only (no podspec); react-native's spm_dependency links it into
  # this pod. Static linking of package products needs USE_FRAMEWORKS=dynamic (set via
  # expo-build-properties in app.json).
  spm_dependency(s,
    url: 'https://github.com/Desert-Ant-Labs/desert-ant-core.git',
    requirement: { kind: 'upToNextMajorVersion', minimumVersion: '3.1.0' },
    products: ['Voz']
  )

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
