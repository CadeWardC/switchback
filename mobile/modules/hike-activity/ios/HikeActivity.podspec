Pod::Spec.new do |s|
  s.name           = 'HikeActivity'
  s.version        = '1.0.0'
  s.summary        = 'Shows a hike on the lock screen'
  s.description    = 'Starts, updates and ends the Live Activity that shows a hike being recorded on the lock screen.'
  s.author         = 'Switchback'
  s.homepage       = 'https://github.com/CadeWardC/switchback'
  s.platform       = :ios, '16.4'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
