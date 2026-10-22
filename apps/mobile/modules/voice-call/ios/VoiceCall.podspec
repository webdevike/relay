Pod::Spec.new do |s|
  s.name           = 'VoiceCall'
  s.version        = '1.0.0'
  s.summary        = 'Audio for Relay calls: echo-cancelled microphone frames out, streamed reply audio in'
  s.description    = 'AVAudioEngine with voice processing: 16 kHz PCM16 microphone frames to JS, 24 kHz PCM16 playback with flush for barge-in.'
  s.author         = ''
  s.homepage       = 'https://github.com/webdevike/relay'
  s.platforms      = { :ios => '18.0' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
