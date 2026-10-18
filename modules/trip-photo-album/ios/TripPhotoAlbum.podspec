Pod::Spec.new do |s|
  s.name = 'TripPhotoAlbum'
  s.version = '1.0.0'
  s.summary = 'Trip system photo album'
  s.description = 'Preserve original Trip photos in an iOS Photos album.'
  s.license = 'MIT'
  s.author = 'Trip'
  s.homepage = 'https://github.com/qiuzizhao'
  s.platforms = { :ios => '15.1' }
  s.swift_version = '5.9'
  s.source = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Photos', 'CryptoKit'
  s.source_files = '**/*.swift'
end
