Pod::Spec.new do |s|
  s.name           = 'PasteImage'
  s.version        = '1.0.0'
  s.summary        = 'Paste an image from the clipboard into a text input'
  s.description    = 'Lets React Native text inputs offer Paste for a copied image and hands it to JS.'
  s.author         = ''
  s.homepage       = 'https://example.invalid'
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
