Pod::Spec.new do |s|
  s.name           = 'LiveCall'
  s.version        = '1.0.0'
  s.summary        = 'Live calls for Relay: a GPT-Live voice conversation with an assistant over WebRTC'
  s.description    = 'Native call engine (WebRTC to OpenAI, the Relay host link, the Live Activity) shared by the JS module and the App Intents.'
  s.author         = ''
  s.homepage       = 'https://github.com/webdevike/relay'
  s.platforms      = { :ios => '18.0' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # webrtc-sdk's prebuilt WebRTC (the build LiveKit ships): voice-processing audio unit, data channels.
  s.dependency 'WebRTC-SDK', '144.7559.15'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
