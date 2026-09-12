const { withDangerousMod, withInfoPlist } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const SCENE_DELEGATE_CLASS = 'TripSceneDelegate';
const SCENE_LIFECYCLE_METHODS = `  public func application(
    _ application: UIApplication,
    configurationForConnecting connectingSceneSession: UISceneSession,
    options: UIScene.ConnectionOptions
  ) -> UISceneConfiguration {
    let configuration = UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
    configuration.delegateClass = SceneDelegate.self
    return configuration
  }

  fileprivate func startReactNative(
    in window: UIWindow,
    launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) {
    self.window = window
    reactNativeFactory?.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
  }
`;
const SCENE_DELEGATE = `@objc(${SCENE_DELEGATE_CLASS})
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene else {
      return
    }

    let window = UIWindow(windowScene: windowScene)
    self.window = window
    (UIApplication.shared.delegate as? AppDelegate)?.startReactNative(in: window)
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    URLContexts.forEach { context in
      var options: [UIApplication.OpenURLOptionsKey: Any] = [
        .openInPlace: context.options.openInPlace
      ]

      if let sourceApplication = context.options.sourceApplication {
        options[.sourceApplication] = sourceApplication
      }
      if let annotation = context.options.annotation {
        options[.annotation] = annotation
      }

      _ = RCTLinkingManager.application(UIApplication.shared, open: context.url, options: options)
    }
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    _ = RCTLinkingManager.application(
      UIApplication.shared,
      continue: userActivity,
      restorationHandler: { _ in }
    )
  }
}
`;

function withIosSceneLifecycle(config) {
  config = withInfoPlist(config, (config) => {
    config.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: 'Default Configuration',
            UISceneDelegateClassName: SCENE_DELEGATE_CLASS,
          },
        ],
      },
    };
    return config;
  });

  return withDangerousMod(config, [
    'ios',
    async (config) => {
      const appDelegatePath = path.join(
        config.modRequest.platformProjectRoot,
        config.modRequest.projectName,
        'AppDelegate.swift'
      );
      const podfilePath = path.join(config.modRequest.platformProjectRoot, 'Podfile');
      const xcodeProjectPath = path.join(
        config.modRequest.platformProjectRoot,
        `${config.modRequest.projectName}.xcodeproj`,
        'project.pbxproj'
      );
      const appDelegate = fs.readFileSync(appDelegatePath, 'utf8');
      fs.writeFileSync(appDelegatePath, patchAppDelegate(appDelegate));
      const podfile = fs.readFileSync(podfilePath, 'utf8');
      fs.writeFileSync(podfilePath, patchPodfile(podfile));
      const xcodeProject = fs.readFileSync(xcodeProjectPath, 'utf8');
      fs.writeFileSync(
        xcodeProjectPath,
        patchXcodeProjectVersions(xcodeProject, config.version, config.ios?.buildNumber)
      );
      return config;
    },
  ]);
}

function patchAppDelegate(source) {
  let output = source;

  output = removeSceneLifecycleMethods(output);
  output = removeSceneDelegate(output);

  output = output.replace(
    /#if os\(iOS\) \|\| os\(tvOS\)\n\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\n\s*factory\.startReactNative\(\n\s*withModuleName: "main",\n\s*in: window,\n\s*launchOptions: launchOptions\)\n#endif/,
    `#if os(iOS) || os(tvOS)
    if #available(iOS 13.0, tvOS 13.0, *) {
      return super.application(application, didFinishLaunchingWithOptions: launchOptions)
    }

    window = UIWindow(frame: UIScreen.main.bounds)
    if let window {
      startReactNative(in: window, launchOptions: launchOptions)
    }
#endif`
  );

  output = output.replace('\n  // Linking API', `\n${SCENE_LIFECYCLE_METHODS}\n  // Linking API`);
  output = `${output.trimEnd()}\n\n${SCENE_DELEGATE}`;

  return output;
}

function removeSceneLifecycleMethods(source) {
  return source.replace(
    /\n\s+public func application\(\n\s+_ application: UIApplication,\n\s+configurationForConnecting connectingSceneSession: UISceneSession,\n\s+options: UIScene\.ConnectionOptions\n\s+\) -> UISceneConfiguration \{\n\s+let configuration = UISceneConfiguration\(name: "Default Configuration", sessionRole: connectingSceneSession\.role\)\n\s+configuration\.delegateClass = SceneDelegate\.self\n\s+return configuration\n\s+\}\n\n\s+fileprivate func startReactNative\(\n\s+in window: UIWindow,\n\s+launchOptions: \[UIApplication\.LaunchOptionsKey: Any\]\? = nil\n\s+\) \{\n\s+self\.window = window\n\s+reactNativeFactory\?\.startReactNative\(\n\s+withModuleName: "main",\n\s+in: window,\n\s+launchOptions: launchOptions\)\n\s+\}\n/g,
    ''
  );
}

function removeSceneDelegate(source) {
  return source.replace(
    new RegExp(`\\n+@objc\\(${SCENE_DELEGATE_CLASS}\\)\\nclass SceneDelegate: UIResponder, UIWindowSceneDelegate \\{[\\s\\S]*\\n\\}\\s*$`),
    ''
  );
}

function patchPodfile(source) {
  if (source.includes('Codex: keep all Pods on an Xcode 27-compatible iOS deployment target.')) {
    return source;
  }

  return source.replace(
    /(\s+react_native_post_install\(\n\s+installer,\n\s+config\[:reactNativePath\],\n\s+:mac_catalyst_enabled => false,\n\s+:ccache_enabled => ccache_enabled\?\(podfile_properties\),\n\s+\)\n)/,
    `$1
    # Codex: keep all Pods on an Xcode 27-compatible iOS deployment target.
    minimum_deployment_target = Gem::Version.new('15.1')
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |config|
        current_target = config.build_settings['IPHONEOS_DEPLOYMENT_TARGET']
        if current_target.nil? || Gem::Version.new(current_target) < minimum_deployment_target
          config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = minimum_deployment_target.to_s
        end
      end
    end
`
  );
}

function patchXcodeProjectVersions(source, version, buildNumber) {
  if (!version || !buildNumber) {
    return source;
  }

  return source
    .replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`)
    .replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${buildNumber};`);
}

module.exports = withIosSceneLifecycle;
