# Joplin 源码 vendor 目录

本目录是从 Joplin 复用的同步传输层代码。**这里的文件不是 Trip 自己写的**，除非必要，不要直接改动它们的逻辑；需要升级时按下面的对照表重新从上游取。

## 来源

| 项 | 值 |
| --- | --- |
| 上游仓库 | https://github.com/laurent22/joplin |
| commit | `141c451ff938e96fd0d21dab027147e59e0bf0e3` |
| commit 日期 | 2026-09-12 |
| 拉取方式 | `git clone --depth 1 --filter=blob:none --sparse`，`sparse-checkout set packages/lib packages/app-mobile` |
| 拉取日期 | 2026-09-13 |

## 文件对照与本地改动

| 本目录文件 | 上游路径 | 行数 | 本地改动 |
| --- | --- | --- | --- |
| `file-api.ts` | `packages/lib/file-api.ts` | 671 | 仅把 `@joplin/utils/Logger` 的导入改为 `./utils/Logger` |
| `AsyncActionQueue.ts` | `packages/lib/AsyncActionQueue.ts` | 161 | 同上（Logger 导入） |
| `TaskQueue.ts` | `packages/lib/TaskQueue.ts` | 206 | 同上（Logger 导入）；`Setting` 由本地替身提供 |
| `mime-utils.ts` | `packages/lib/mime-utils.ts` | 46 | 无 |
| `mime-utils-types.ts` | `packages/lib/mime-utils-types.ts` | 792 | 无 |
| `JoplinError.ts` | `packages/lib/JoplinError.ts` | 14 | 无 |
| `ArrayUtils.ts` | `packages/lib/ArrayUtils.ts` | 100 | 无 |
| `file-api-driver-memory.ts` | `packages/lib/file-api-driver-memory.ts` | 232 | `fs-extra` 两处调用改为 `shim.fsDriver()` |

## 本地替身（我们自己写的，不是上游代码）

上游的这几个模块依赖 Node/Electron（`moment`、`locale`、`fs`、`Setting` 1500 行等），因此按**上游相同的导入路径**提供最小替身，这样 vendored 文件本身几乎不用改：

| 替身文件 | 对应上游 | 说明 |
| --- | --- | --- |
| `time.ts` | `packages/lib/time.ts` | 只实现 `unixMs` / `msleep` / `sleep`（上游依赖 `moment`） |
| `utils/Logger.ts` | `@joplin/utils` 包 | 最小 Logger（class，含 static `create`） |
| `shim.ts` | `packages/lib/shim.ts`（636 行） | 只实现被调用的能力：`fetchMaxRetrySet` / `fsDriver`（expo-file-system）/ 定时器 / `fetch` |
| `path-utils.ts` | `packages/lib/path-utils.ts` | 只实现 `isHidden` |
| `models/BaseItem.ts` | `packages/lib/models/BaseItem.ts`（1123 行） | 三个纯函数 `systemPath` / `isSystemPath` / `pathToId` + `RemoteItemMetadata` 类型，源码抄自上游 46-50、174-253 行 |
| `models/Setting.ts` | `packages/lib/models/Setting.ts`（1502 行） | 只提供 `sync.maxConcurrentConnections = 3`；其余键返回 `null` |
| `SyncTargetRegistry.ts` | `packages/lib/SyncTargetRegistry.ts` | 只提供 `nameToId()`（我们不使用 filesystem/webdav 分支） |
| `services/synchronizer/LockHandler.ts` | `packages/lib/services/synchronizer/LockHandler.ts` | 只保留枚举与 `Lock` 类型（上游 9-27 行） |

## 运行时依赖

vendored 代码直接依赖以下 npm 包（均已加入 `dependencies`）：

- `async-mutex@0.5.0`（MIT）——`file-api.ts` 的 `remoteDateMutex_`
- `sprintf-js@1.1.3`（BSD-3-Clause）——`file-api.ts:647` 的 fail-safe 错误信息

## 类型检查策略

Trip 的 `tsconfig` 是 `strict: true`，而 Joplin 的 `packages/lib` 是在 `strict: false` 下编写的（大量 `= null` 默认值、可空属性）。因此**所有 vendored 文件首行都加了 `// @ts-nocheck`**：

- 我们自己的代码仍然享受完整严格检查；
- vendored 代码保持与上游逐字一致，便于将来重新对照升级；
- 因此对 vendored 代码的验证依赖 **测试**（见 `src/sync/__tests__/fileApi.smoke.test.ts`），而不是类型系统。

## 已知限制

- `file-api-driver-memory.ts` 依赖 Node 全局 `Buffer`，**只用于单测**（Jest/Node 环境），App 运行时不加载。
- `models/Setting.ts` 是替身，只覆盖 vendored 代码当前用到的键；如果将来 vendored 代码增加 `Setting` 调用点，需要同步补充。

## 升级上游时怎么做

1. 重新按上面的方式拉取指定 commit 的上游文件；
2. 按本 README 的对照表重新套用「本地改动」那一列（只有 Logger 导入与 `fs-extra` 两处）；
3. 跑 `npx tsc --noEmit`、`npx jest`，重点看 `fileApi.smoke.test.ts` 与 `basicDelta` 相关用例；
4. 更新本 README 的 commit 与日期。
