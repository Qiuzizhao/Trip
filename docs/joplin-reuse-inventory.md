# Joplin 源码可复用清单（仅用于 Trip）

> 源码位置：`/tmp/joplin-src`（`git clone --depth 1 --filter=blob:none --sparse`，已检出 `packages/lib` + `packages/app-mobile`，2026-09-13）。
> 范围：只改 Trip；**WorkLog 不动**。
> 结论先说：**整包不能复用，能复用的是「若干几十行的小件 + 一套结构」**。

---

## A. 可以直接抄进 Trip 的（小件，微改即可用）

| # | Joplin 源（文件:行） | 规模 | 依赖 | 落到 Trip 的位置 | 需要的改动 |
| --- | --- | --- | --- | --- | --- |
| 1 | `models/Resource.ts:62-65` fetch 状态常量 | 4 行 | 无 | `src/local/repositories/assetRepository.ts` | 直接照搬（IDLE/STARTED/DONE/ERROR） |
| 2 | `models/ResourceLocalState.ts` 整文件 | 45 行 | 仅 BaseModel | 只借**表结构思路**，不拷代码 | `resource_id` / `fetch_status` / `fetch_error` 三字段 |
| 3 | `file-api.ts:79-125` 重试策略（`requestCanBeRepeated` + `tryAndRepeat`） | 47 行 | `shim.fetchMaxRetrySet` | `src/sync/retry.ts` | 去掉 shim 调用，退避参数改成 `1+n*3` 秒即可 |
| 4 | `app-mobile/utils/shim-init-react/index.ts:134-156` RN 上传实现 | 23 行 | `RNFetchBlob` | `src/sync/assetBlobTransport.ts` | 把 `RNFetchBlob.wrap(path)` 换成 `FileSystem.uploadAsync(url, path, …)` |
| 5 | `Synchronizer.ts:779-790` blob 变更判定 | 12 行 | BaseItem | `src/sync/assetQueue.ts`（判定函数） | 换成 `!asset.remoteKey \|\| asset.syncTime < asset.blobUpdatedTime \|\| asset.forceSync` |
| 6 | `Synchronizer.ts:735-767` 「没有本地字节就不上传」 | 33 行 | Resource/logger | `src/sync/assetQueue.ts` | 换成 `fetchStatus !== DONE` → 标记 `cannot_sync` 并跳过 |
| 7 | `JoplinServerApi.ts:220-226` 上传前 stat + 设 Content-Length | 7 行 | 无 | `src/sync/assetBlobTransport.ts` | 用 `FileSystem.getInfoAsync(uri).size` |
| 8 | `mime-utils.ts:1-46` + `mime-utils-types.ts`（792 行表） | 838 行 | 无 | `src/shared/mime.ts`（**可选**） | Trip 只处理 6 种图片格式，现有 `contentTypeForExtension` 已够；除非以后要支持任意文件类型 |
| 9 | `services/synchronizer/utils/resourceRemotePath.ts` | 5 行 | 无 | `src/sync/objectKey.ts` | 对象 key 约定：`assets/<asset_id>.<ext>` |
| 10 | `AsyncActionQueue.ts` 整文件 | 161 行 | `@joplin/utils/Logger`、`./shim` | `src/sync/asyncActionQueue.ts`（**可选**） | Logger 换 console；功能与 `p-queue` 重叠，二选一 |

以上 1~7、9 合计约 **130 行**真正要拷贝/改写的代码，覆盖了这次全部核心逻辑（状态机 + 变更判定 + 拒绝空上传 + 重试 + 流式上传）。

---

## B. 照它的结构翻译（流程照抄，代码重写）

| Joplin 机制 | 源位置 | Trip 的等价实现 |
| --- | --- | --- |
| 两阶段同步：先同步「项」，再按判定传 blob | `Synchronizer.ts` 主循环；`syncSteps = ['update_remote','delete_remote','delta']`（`Synchronizer.ts:415`） | `manualSync()` 拆成「元数据合并」+「资产队列」两个阶段 |
| 增量接口 + 持久化游标 | `file-api.ts:441` `delta()`；`Synchronizer.ts:890-935`；游标保存 `Synchronizer.ts:1168-1184` | `updated_at > cursor` 查询 + 游标存本地元数据 |
| 错误分类（fileNotFound / IsReadOnly / cannotSyncItem / failSafe） | `file-api.ts:79` 起、`Synchronizer.ts:735-767`、`errors.ts` | 定义自己的错误码：`local_blob_missing` / `upload_empty` / `network` / `auth`，分别决定重试还是跳过 |
| 资源与记录分离、关联表判孤儿 | `resources` / `note_resources`（`services/database/types.ts:223-230, 302-328`） | `trip_footprint_assets` 表 + 记录引用 asset id |
| 删除用墓碑 + 保留期 | `deleted_time` 语义 | 现有 `deleted_at` 沿用，物理删除延后 |

---

## C. 不建议复用（成本 > 收益）

| 对象 | 规模 | 为什么不能直接用在 Trip |
| --- | --- | --- |
| `@joplin/lib`（npm 已发布，3.7.1） | 依赖 `@aws-sdk/*`、`fs-extra`、`execa`、`node-fetch`、`glob`、`moment` + 38 个内部 `@joplin/*` 包 | 为桌面/Electron 与插件设计。Joplin 移动端为跑它，额外装了 `assert-browserify`、`buffer`、`crypto-browserify`、`events`、`path-browserify`、`punycode`、`stream-browserify`、`url`、`react-native-quick-crypto`、`rn-fetch-blob` 等一整套 polyfill。搬它=把整个 Joplin 数据层搬进 Trip |
| `packages/lib` 全量 | 128 个 TS 文件、约 26,500 行 | 含数据库迁移系统、E2EE、分享、OCR、搜索、多 sync target 抽象，全部与我们的需求无关 |
| `Synchronizer.ts` 整文件 | 1,331 行 | import 30 个模块（BaseItem/BaseModel/JoplinDatabase/Setting/registry/加密/分享），无法单独摘出 |
| `ResourceService.ts` | 225 行 | 依赖 SearchEngine、事件系统、ItemChange、PerformanceLogger |
| `TaskQueue.ts` | 206 行 | 依赖 `models/Setting`；功能等价于 `p-queue`（MIT、周下载 2500 万），用后者更省事 |
| E2EE / 多 sync target / 分享 / OCR | — | 私人自用不需要 |

---

## D. 两个有用的旁证

1. **Joplin 移动端的本地数据库用的就是 `expo-sqlite`**（`packages/app-mobile/package.json` 的 dependencies 里有 `expo-sqlite`）——和我之前的建议一致，Trip 要升级本地存储时可以直接照做，版本用 SDK 54 对应的 `~16.0.10`。
2. **Joplin RN 端上传用的库是 `rn-fetch-blob`**（已废弃），其官方继任者就是 `react-native-blob-util`。也就是说：只需要把 `FileSystem.uploadAsync` 换成 `react-native-blob-util.wrap(path)`，就能达到和 Joplin 完全同级的传输强度。

---

## E. 落到 Trip 的实施顺序（据此清单）

| 阶段 | 复用清单里的哪些 | 新增/改动文件 |
| --- | --- | --- |
| 1（本地资产模型） | A1、A2、A9 | 新增 `src/local/repositories/assetRepository.ts`、`src/sync/objectKey.ts`；改编辑器与列表读路径 |
| 2（远端表 + 双写） | B 的资源/关联表结构 | 新增 `docs/supabase` 迁移 SQL；改 `manualSync.ts` |
| 3（传输管线） | A3、A4、A5、A6、A7 | 新增 `src/sync/assetQueue.ts`、`src/sync/assetBlobTransport.ts`、`src/sync/retry.ts` |
| 4（增量 + 对账） | B 的 delta/游标 | 新增 `scripts/audit-assets.mjs`；改 repo 查询 |
| 5（体验层） | — | 图片级状态 UI、服务端缩略图 |

> 注意：A4 若选 `react-native-blob-util`，需要 `npx expo prebuild --platform ios` 并重装 App；只做阶段 1~2 的话不涉及原生依赖。
