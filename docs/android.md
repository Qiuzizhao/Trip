# Trip Android APK

安卓包名为 `com.qiuzizhao.tripfootprints`，版本以 `app.json` 为准。使用本地 Expo prebuild 和 Gradle 构建。

支持足迹编辑、照片选择与预览、账号同步，以及从系统相册分享单张/多张照片到新足迹。分享照片先复制到应用私有目录，完整导入后才打开编辑页，保存后才创建足迹。

Android 使用系统照片选择器，无需申请整个图库、相机或录音权限。底部内容避让手势区域与三键导航栏，图片预览支持系统返回键。iOS 专用的 Trip 系统相簿自动保存、核对恢复和重复照片清理暂未移植到 Android。

## 本地构建

需要 JDK 17、Android SDK 36、Build Tools 36.0.0。macOS Homebrew 默认安装路径由脚本识别；其他环境设置 `JAVA_HOME`、`ANDROID_HOME`。

```sh
npm ci
# 按既有发布流程，确认更新说明、同步源代码后生成原生工程。
CI=1 npx expo prebuild --platform android --no-install
bash scripts/build-android.sh release
```

APK 输出至 `dist/Trip-<版本>-<versionCode>-release.apk`。正式包内置 JavaScript，可离线启动，不需要 Metro。调试包使用 `bash scripts/build-android.sh debug`，需要 `npx expo start`。

## 签名

正式包通过 `plugins/with-android-signing.js` 读取本机 `~/.config/trip/android-signing.properties`，缺失时拒绝构建正式包。文件格式：

```properties
storeFile=/absolute/path/to/trip-release.jks
storePassword=<本机密码>
keyAlias=trip
keyPassword=<本机密码>
```

签名文件、密码及密钥库不进入仓库。后续升级必须保留同一签名；迁移构建机器时安全转移密钥库与本机配置。

## 验收

- 安装 APK，离线启动，打开设置、创建并编辑足迹。
- 系统照片选择器选择多张照片，确认保存、预览及横竖屏切换。
- 从相册分别分享单张、多张照片，覆盖冷启动、前台、后台与重复文件名；确认图片顺序及完整性，取消不会创建足迹。
- 检查三键导航/手势导航、键盘、系统返回键。
- 核对包名、版本、ABI、签名和 APK SHA-256。
