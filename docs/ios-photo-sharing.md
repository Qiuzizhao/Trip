# iOS 相册分享到 Trip

在相册选中一张或多张照片 → 分享 → Trip。首次使用可以在分享列表的「更多」中找到 Trip。

Trip 打开「记录新足迹」，自动带入全部照片。补充地点等信息并保存后才创建足迹，取消不会创建记录。

## 实现

- `expo-share-intent` 5.x 接收 iOS 分享，`with-trip-share-extension` 为 SDK 54 生成图片专用的 ShareExtension 和 App Group。
- 自定义扩展按顺序复制原文件，保留 HEIC / EXIF；所有附件复制完成才交给主 App，失败时取消整批导入。
- 主 App 先把照片复制到自己的 Documents，再保存本地草稿并进入编辑页；之后清理共享容器中的临时文件和原生分享事件。
- `+native-intent` 将内部分享链接映射到有效页面；UIScene 冷启动向 React Native 传递分享 URL。
- 每次分享使用不同草稿标识，避免覆盖正在编辑的足迹。

## 构建与验证

这是原生扩展，需要重新构建并安装 iOS App，Expo Go 或单独更新 JavaScript 无法新增相册分享入口。
发布签名需要主 App 和 `com.qiuzizhao.tripfootprints.share-extension` 都启用 `group.com.qiuzizhao.tripfootprints`。

自动测试覆盖图片筛选和顺序、全部持久化后创建草稿、失败回滚、草稿读取及内部分享链接映射。
真机验收应分别测试 App 未启动、已在前台和已在后台，包含单张、多张、HEIC、iCloud 照片及连续两次分享；确认全部照片进入新足迹，并能保存、取消和继续加图。
