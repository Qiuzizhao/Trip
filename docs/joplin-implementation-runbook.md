# 执行手册：按 Joplin 改造 Trip（照抄级步骤）

> 配套文档：`joplin-max-reuse-plan.md`（路线选择）、`joplin-reuse-inventory.md`（可复用清单）、`asset-sync-design.md`（目标架构）。
> 源码基线：`/tmp/joplin-src`（`laurent22/joplin`，commit 见 0.1）。
> 范围：只改 Trip。**WorkLog 不动。**
> 原则：能原样搬就原样搬；只对本文明确列出的行做改动。

---

## 阶段 0：vendor 落地（不动现有逻辑，可独立验证）

### 0.1 记录来源（先做，写进 README）

```bash
cd /tmp/joplin-src
git rev-parse HEAD
git log -1 --format='%H %cd %s' --date=short
```

把输出写进 `src/vendor/joplin/README.md`。

### 0.2 建目录

```bash
cd /Volumes/Data/Projects/Trip
mkdir -p src/vendor/joplin src/sync/supabase
```

### 0.3 复制文件（全部是新增文件）

```bash
SRC=/tmp/joplin-src/packages/lib
DEST=/Volumes/Data/Projects/Trip/src/vendor/joplin
cp "$SRC/file-api.ts"               "$DEST/file-api.ts"
cp "$SRC/AsyncActionQueue.ts"       "$DEST/AsyncActionQueue.ts"
cp "$SRC/TaskQueue.ts"              "$DEST/TaskQueue.ts"
cp "$SRC/mime-utils.ts"             "$DEST/mime-utils.ts"
cp "$SRC/mime-utils-types.ts"       "$DEST/mime-utils-types.ts"
cp "$SRC/JoplinError.ts"            "$DEST/JoplinError.ts"
cp "$SRC/ArrayUtils.ts"             "$DEST/ArrayUtils.ts"
cp "$SRC/file-api-driver-memory.ts" "$DEST/file-api-driver-memory.ts"
```

> **保留上游文件名**（不要改成 camelCase）：Trip 的 tsconfig 开启了大小写一致性检查，`./JoplinError`、`./ArrayUtils`、`./mime-utils-types` 这些导入会因文件名不同而报 TS1261/TS1149。

**不复制** `time.ts`（依赖 `moment`）与 `path-utils.ts`（依赖 `locale` 和 `@joplin/utils/path`）——这两个自己写小替身（见 0.4）。

复制完先跑一次 `npx tsc --noEmit`，此时的报错清单就是 0.5/0.6 要修的全部内容。

### 0.4 新建 7 个替身文件

#### (1) `src/vendor/joplin/time.ts`

```ts
const time = {
  unixMs: () => Date.now(),
  msleep: (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }),
  sleep: (seconds: number) => new Promise<void>((resolve) => { setTimeout(resolve, seconds * 1000); }),
};
export default time;
```

#### (2) `src/vendor/joplin/logger.ts`

`file-api.ts` 同时用到 `Logger.create()`、`new Logger()` 和把 `Logger` 当类型，所以必须是 class：

```ts
type LogFn = (...args: unknown[]) => void;

export default class Logger {
  private prefix_: string;
  public constructor(name = 'joplin') { this.prefix_ = `[${name}]`; }

  public static create(name: string) { return new Logger(name); }

  public debug: LogFn = (...args) => console.debug(this.prefix_, ...args);
  public info: LogFn = (...args) => console.log(this.prefix_, ...args);
  public warn: LogFn = (...args) => console.warn(this.prefix_, ...args);
  public error: LogFn = (...args) => console.error(this.prefix_, ...args);
}

export type LoggerWrapper = Logger;
```

#### (3) `src/vendor/joplin/mutex.ts`（替代 `async-mutex`）

```ts
export class Mutex {
  private queue_: Promise<void> = Promise.resolve();

  public async acquire(): Promise<() => void> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const waitFor = this.queue_;
    this.queue_ = this.queue_.then(() => gate);
    await waitFor;
    return release;
  }
}
```

#### (4) `src/vendor/joplin/locks.ts`（照抄 `LockHandler.ts:9-27`）

```ts
export enum LockType { None = 0, Sync = 1, Exclusive = 2 }

export enum LockClientType { Desktop = 1, Mobile = 2, Cli = 3 }

export interface Lock {
  id?: string;
  type: LockType;
  clientType: LockClientType;
  clientId: string;
  updatedTime?: number;
}
```

#### (5) `src/vendor/joplin/pathUtils.ts`

```ts
// Joplin 的 isHidden 来自 @joplin/utils/path，这里给等价实现（只用于列表过滤）
export function isHidden(filePath: string) {
  const base = String(filePath || '').split('/').filter(Boolean).pop() || '';
  return base.startsWith('.');
}
```

#### (6) `src/vendor/joplin/systemPath.ts`（照抄 `models/BaseItem.ts:174-253`）

```ts
export interface RemoteItemMetadata {
  item_id: string;
  updated_time: number;
  sync_time: number;
}

export function systemPath(itemOrId: { id: string } | string, extension = 'md') {
  if (typeof itemOrId === 'string') return `${itemOrId}.${extension}`;
  return `${itemOrId.id}.${extension}`;
}

export function isSystemPath(path: string) {
  if (!path || !path.length) return false;
  const parts = path.split('/');
  const last = parts[parts.length - 1];
  const p = last.split('.');
  if (p.length !== 2) return false;
  return p[0].length === 32 && p[1] === 'md';
}

export function pathToId(path: string): string {
  const p = path.split('/');
  const s = p[p.length - 1].split('.');
  const name = s[0];
  if (!name) return name;
  const parts = name.split('-');
  return parts[parts.length - 1];
}
```

> **重要**：`isSystemPath` 要求 id 是 **32 位十六进制**（Joplin 的 id 规则）。Trip 现有 id 形如 `footprint_1789…`，所以同步项的 id 必须换规则（见阶段 3.1），否则 `basicDelta` 会把所有项过滤掉。

#### (7) `src/vendor/joplin/shim.ts`

```ts
import * as FileSystem from 'expo-file-system/legacy';

export const rnFsDriver = {
  async exists(path: string) {
    try { return (await FileSystem.getInfoAsync(path)).exists; } catch { return false; }
  },
  async stat(path: string) {
    const info = await FileSystem.getInfoAsync(path);
    if (!info.exists) throw new Error(`File not found: ${path}`);
    return { size: (info as { size?: number }).size ?? 0, path, isDir: false, updated_time: Date.now() };
  },
  async readFile(path: string, encoding: 'utf8' | 'base64' | 'Buffer' = 'utf8') {
    const map = {
      utf8: FileSystem.EncodingType.UTF8,
      base64: FileSystem.EncodingType.Base64,
      Buffer: FileSystem.EncodingType.Base64,
    };
    return FileSystem.readAsStringAsync(path, { encoding: map[encoding] });
  },
  async writeFile(path: string, content: string) {
    await FileSystem.writeAsStringAsync(path, content, { encoding: FileSystem.EncodingType.UTF8 });
  },
  async unlink(path: string) { await FileSystem.deleteAsync(path, { idempotent: true }); },
  async mkdir(path: string) { await FileSystem.makeDirectoryAsync(path, { intermediates: true }).catch(() => undefined); },
};

export default {
  isReactNative: () => true,
  isNode: () => false,
  fetchMaxRetrySet: (_count: number) => 0, // 重试由 tryAndRepeat 统一控制
  fsDriver: () => rnFsDriver,
  fetch: (url: string, options: RequestInit) => fetch(url, options),
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
  clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
};
```

### 0.5 `fileApi.ts` 逐处编辑（共 12 处，全部列在此）

| # | 原行 | 原文 | 改成 |
| --- | --- | --- | --- |
| 1 | 1 | `import Logger, { LoggerWrapper } from '@joplin/utils/Logger';` | `import Logger, { LoggerWrapper } from './logger';` |
| 2 | 2 | `import shim from './shim';` | 不变（用我们的 shim） |
| 3 | 3 | `import BaseItem, { RemoteItemMetadata } from './models/BaseItem';` | `import { RemoteItemMetadata } from './systemPath';` |
| 4 | 6 | `import { isHidden } from './path-utils';` | `import { isHidden } from './pathUtils';` |
| 5 | 8 | `import { Lock, LockClientType, LockType } from './services/synchronizer/LockHandler';` | `import { Lock, LockClientType, LockType } from './locks';` |
| 6 | 9 | `import * as ArrayUtils from './ArrayUtils';` | `import * as ArrayUtils from './arrayUtils';` |
| 7 | 10-11 | `import Setting …` 与 `import SyncTargetRegistry …` | **删除** |
| 8 | 12 | `const { sprintf } = require('sprintf-js');` | **删除** |
| 9 | 13 | `import { Mutex } from 'async-mutex';` | `import { Mutex } from './mutex';` |
| 10 | 68-76 | `enableEnhancedBasicDeltaAlgorithm` 整函数（用了 Setting/SyncTargetRegistry） | `export const enableEnhancedBasicDeltaAlgorithm = () => false;` |
| 11 | 365/523/556/559/634 | `BaseItem.isSystemPath(...)` / `BaseItem.pathToId(...)` / `BaseItem.systemPath(...)` | 改为 `isSystemPath(...)` / `pathToId(...)` / `systemPath(...)`，并在顶部 `import { isSystemPath, pathToId, systemPath } from './systemPath';` |
| 12 | 647 | `sprintf('Fail-safe: … %d%% … %d items …', a, b)` | 模板字符串 |

`isLocalServer()`（第 58 行附近）是文件内函数，保留。

### 0.6 `asyncActionQueue.ts` / `taskQueue.ts` / `fileApiDriverMemory.ts` 编辑

| 文件 | 处 | 改成 |
| --- | --- | --- |
| `asyncActionQueue.ts` | 1、20 行 Logger | `import Logger from './logger';`，其余不变 |
| `asyncActionQueue.ts` | 31/85/88/144 `shim.setTimeout` 等 | 不变（shim 已提供） |
| `taskQueue.ts` | 3 行 Setting | 删除 import；37 行 `Setting.value('sync.maxConcurrentConnections')` → `3` |
| `taskQueue.ts` | 4 行 Logger | `import Logger, { LoggerWrapper } from './logger';` |
| `fileApiDriverMemory.ts` | 2 行 `fs-extra` | `import shim from './shim';`；112 行 `fs.writeFile` → `shim.fsDriver().writeFile`；130 行 `fs.readFile` → `shim.fsDriver().readFile` |

### 0.7 阶段 0 完成判定

```bash
npx tsc --noEmit     # 期望 0 错误
npx jest             # 期望现有 13 条测试仍全绿
```

### 0.8 `src/vendor/joplin/README.md` 必写内容

上游仓库、commit、拉取日期、每个文件的原路径与目标路径、本目录做过的全部改动（抄 0.5/0.6 两张表）、后续对照上游升级的方法。

### 0.9 执行修正记录（2026-09-13 实际执行）

实际执行时发现「按上游相同导入路径放替身」比「改 12 处调用点」改动更小、也更接近上游原貌，因此调整为下表做法。**以下为最终落地形态，0.4~0.6 以本节为准。**

| 项 | 原方案 | 实际执行 |
| --- | --- | --- |
| 文件名 | 改成 camelCase | **保留上游原名**（见 0.3 的修正说明） |
| `fileApi.ts` 改动量 | 12 处调用点 | **仅 1 处**（Logger 导入改为 `./utils/Logger`） |
| `BaseItem` 的三个纯函数 | 内联进 `systemPath.ts`，改 5 处调用 | 新建 `models/BaseItem.ts` 替身（默认导出同名方法），**0 处改动** |
| `Setting` / `SyncTargetRegistry` | 删导入 + 改函数体 | 新建同名路径替身（`models/Setting.ts` / `SyncTargetRegistry.ts`），**0 处改动** |
| `LockHandler` | 新建 `locks.ts` 并改导入 | 新建 `services/synchronizer/LockHandler.ts`（同路径），**0 处改动** |
| `async-mutex` | 自己写 `mutex.ts` | **安装 `async-mutex@0.5.0`（MIT）** |
| `sprintf-js` | 改模板字符串 | **安装 `sprintf-js@1.1.3`（BSD-3-Clause）** |
| 类型检查 | 未说明 | vendored 文件统一加 `// @ts-nocheck`（上游 `strict:false`，见 README） |

替身文件最终位置（全部按上游导入路径命名，`src/vendor/joplin/` 下）：

```
time.ts                                   ← 上游 ./time
shim.ts                                   ← 上游 ./shim
path-utils.ts                             ← 上游 ./path-utils（只实现 isHidden）
utils/Logger.ts                           ← 上游 @joplin/utils/Logger
models/BaseItem.ts                        ← 上游 ./models/BaseItem
models/Setting.ts                         ← 上游 ./models/Setting
SyncTargetRegistry.ts                     ← 上游 ./SyncTargetRegistry
services/synchronizer/LockHandler.ts      ← 上游 ./services/synchronizer/LockHandler
```

阶段 0 验收结果（2026-09-13）：`npx tsc --noEmit` = 0 错误；`npx jest` = 13/13 通过。

---

## 阶段 1：用 memory driver 跑通 FileApi（不联网）

### 1.1 `src/sync/supabase/fileApiFactory.ts`

```ts
import { FileApi } from '@/src/vendor/joplin/fileApi';
import FileApiDriverMemory from '@/src/vendor/joplin/fileApiDriverMemory';

export function createMemoryFileApi() {
  const fileApi = new FileApi('/root', new FileApiDriverMemory());
  fileApi.setSyncTargetId(1);
  return fileApi;
}
```

### 1.2 `src/sync/__tests__/fileApi.smoke.test.ts`

```ts
import { describe, expect, it } from '@jest/globals';
import { createMemoryFileApi } from '../supabase/fileApiFactory';

const ITEM_ID = '1b175bb38bba47baac22b0b47f778113'; // 32 位 hex，符合 isSystemPath

describe('vendored FileApi (memory driver)', () => {
  it('put/list/stat/get/delete 闭环', async () => {
    const api = createMemoryFileApi();
    await api.put(`${ITEM_ID}.md`, JSON.stringify({ hello: 'world' }));

    const stat = await api.stat(`${ITEM_ID}.md`);
    expect(stat.path).toContain(ITEM_ID);

    const body = await api.get(`${ITEM_ID}.md`);
    expect(JSON.parse(body as string)).toEqual({ hello: 'world' });

    const list = await api.list();
    expect(list.items.length).toBe(1);

    await api.delete(`${ITEM_ID}.md`);
    await expect(api.get(`${ITEM_ID}.md`)).rejects.toThrow();
  });

  it('basicDelta 能识别新增与无变化', async () => {
    const api = createMemoryFileApi();
    await api.put(`${ITEM_ID}.md`, 'v1');

    const first = await api.delta('', { context: null, allItemIdsHandler: async () => [ITEM_ID] } as never);
    expect(first.items.length).toBeGreaterThan(0);

    const second = await api.delta('', { context: first.context, allItemIdsHandler: async () => [ITEM_ID] } as never);
    expect(second.items.length).toBe(0);
  });
});
```

### 1.3 运行

```bash
npx jest src/sync/__tests__/fileApi.smoke.test.ts
```

跑通即证明 vendored 的 `FileApi` + `basicDelta` + memory driver 在该环境下可用，可以进入阶段 2。

#### 1.4 执行记录（2026-09-13）

- 结果：**3/3 通过**（`put/stat/get/list/delete` 闭环、`basicDelta` 增量与 context 复用、远端删除识别为 `isDeleted`）。
- 修正一处计划错误：memory driver 的 `get()` 对不存在的项返回 **`null`**（不抛错），测试断言据此调整。
- 修正一处计划错误（已同步到 3.2）：`FileApi.delta()` 直接委托 `driver_.delta()`，**driver 必须自己实现 `delta()` 并调用 `basicDelta`**，不会自动兜底。
- 全量校验：`npx tsc --noEmit` = 0 错误；`npx jest` = 16/16 通过（原有 13 条 + 本阶段 3 条）。
- 已知噪音：vendored `FileApi` 每次调用都会 `console.debug`，测试输出较多。这是上游行为，暂不改动。

---

## 阶段 2：本地资产模型（客户端先行）

### 2.1 新建 `src/local/repositories/assetRepository.ts`

```ts
// 状态常量照抄 Joplin models/Resource.ts:62-65
export const ASSET_IDLE = 0;
export const ASSET_STARTED = 1;
export const ASSET_DONE = 2;
export const ASSET_ERROR = 3;

export type Asset = {
  id: string;              // 32 位 hex，同时是同步项 id 的基础
  footprintId: string;
  position: number;
  fileName: string;        // 沙盒文件名 = `${id}.${ext}`
  size: number;
  mime: string;
  blobUpdatedTime: number; // 内容变更时间；改标题/备注不影响它
  remoteKey: string | null;
  fetchStatus: number;
  fetchError: string | null;
  syncTime: number;        // 上次成功同步时间
  forceSync: boolean;
};
```

需要实现的方法：

```ts
listAssetsByFootprint(footprintId: string): Promise<Asset[]>
createAssetFromLocalFile(input: { footprintId: string; position: number; localUri: string }): Promise<Asset>
markAssetUploaded(input: { assetId: string; remoteKey: string }): Promise<void>
markAssetFailed(input: { assetId: string; error: string }): Promise<void>
markAssetCannotSync(input: { assetId: string; reason: string }): Promise<void>
setAssetBlobUpdated(assetId: string, timestamp: number): Promise<void>
deleteAssetsByFootprint(footprintId: string): Promise<void>
listAssetsNeedingUpload(): Promise<Asset[]>
```

存储：先用 AsyncStorage（键 `trip-footprints.assets`）；量大了换 `expo-sqlite`（`npx expo install expo-sqlite`，SDK 54 对应 `~16.0.10`）。

### 2.2 旧数据迁移（一次、幂等）

在 `prewarmFootprintScreenData()` 之后调用 `migrateFootprintImagesToAssets()`：

1. 读 `listFootprintsForSync()` 全部记录；
2. 逐条处理 `image_urls`：
   - `file://` 且文件存在 → 建 asset（`fetchStatus=DONE`，`size` 取 `stat`，`blobUpdatedTime=Date.now()`），并用 `FileSystem.moveAsync` 把文件改名成 `<assetId>.<ext>`；
   - `https://` 且能解析成 `<user>/<footprint>/<n>-<hash>.<ext>` → 建 asset（`remoteKey` = 该 key，`fetchStatus=DONE`，`size=0`，`syncTime=0` 触发一次校验）；
3. 写标记 `trip-footprints.assetsMigratedAt`，避免重复执行。

### 2.3 读路径改造

| 文件 | 改动 |
| --- | --- |
| `src/features/daily/footprints/assetResolver.ts`（新增） | `resolveAssetUri(asset)`：本地文件存在 → `file://…`；否则 `publicUrl(remoteKey)` |
| `FootprintScreen.tsx` | `footprintImageUris(item)` 改为读 asset 列表 |
| `FootprintAlbumScreen.tsx` | 同上 |
| `FootprintEditorScreen.tsx` | 保存时写 asset（不再直接写 `image_urls`）；删除时同步删 asset 与本地文件 |
| `imageCache.ts` | 远端 `cacheKey` 用 `remoteKey`（不可变）；本地 URI 不加 cacheKey |

> **迁移期双写（执行时修正）**：阶段 2~3 期间 **`image_urls` 继续写**，作为现有同步路径与旧版本的镜像；asset 是新增的真相层。只有到了阶段 4 才让同步改为读 asset。否则 `manualSync` 会在阶段 2 就失去输入。

#### 2.4 执行记录（2026-09-13）

已完成 2.1 / 2.2 与迁移挂钩：

| 产出 | 说明 |
| --- | --- |
| `src/local/repositories/assetRepository.ts` | 资产表（AsyncStorage 键 `trip-footprints.assets`）：状态常量、`createAssetFromLocalFile`（选图后复制成 `<id>.<ext>`）、`createAssetFromExistingFile`（迁移用 move）、`listAssetsByFootprint`、`listAssetsNeedingUpload`、`markAssetUploaded/Failed/CannotSync`、`setAssetBlobUpdated`、`deleteAssetsByFootprint` |
| `src/features/daily/footprints/assetResolver.ts` | `resolveAssetUri()`：本地文件优先 → 远端 `remoteKey` 拼公共 URL；`publicUrlForObjectKey()` |
| `src/local/repositories/assetMigration.ts` | 幂等迁移：本地文件 move 改名、远端 URL 解析 `remoteKey` 登记；标记键 `trip-footprints.assetsMigratedAt` |
| `src/local/homePreload.ts` | 预热时触发迁移（`void … .catch()`，失败不影响预热） |
| `src/local/__tests__/assetRepository.test.ts` | 7 条测试：命名/大小/类型、排序与待上传、失败状态、本地优先回退远端、迁移两种来源、迁移幂等、URL 解析 |

执行中发现并修正的两处计划外问题：

1. **`footprintImageFiles.ts` 的动态 import 在 Jest 下不可用**（`A dynamic import callback was invoked without --experimental-vm-modules`，异常被 catch 吞掉导致 `ensureFootprintImageDirectory()` 恒返回 null）。已改为**静态导入** `expo-file-system/legacy`，行为不变但可测。
2. 测试环境需要显式设置 `EXPO_PUBLIC_SUPABASE_URL`，否则 `publicUrlForObjectKey()` 返回 null（应用运行时由 Expo 注入该变量）。

验收：`npx tsc --noEmit` = 0 错误；`npx jest` = **23/23 通过**。

#### 2.5 2.3 的执行结果与顺序调整（2026-09-13）

已完成**写路径**：

- 新增 `src/local/repositories/assetSync.ts`：`rebuildAssetsForFootprint(footprintId, imageUris)` —— 把记录里的图片列表与 asset 对齐，并返回应写回记录的**镜像路径**。
  - 已对齐时直接返回原列表（避免每次保存都改文件名）；
  - 本地文件用 `move` 改名为 `<assetId>.<ext>`，镜像路径同步更新；
  - 远端 URL 只登记 `remoteKey`，镜像路径不变。
- `FootprintEditorScreen.save()`：写记录拿到 id → `rebuildAssetsForFootprint()` → 路径有变化时再写一次记录（**双写**：asset + `image_urls`）。
- `objectKeyFromPublicUrl` 从 `assetMigration.ts` 移到 `assetResolver.ts`（与 `publicUrlForObjectKey` 成对），迁移模块改为引用它。
- 新增 2 条测试（对齐后不 churn、远端 URL 登记），本阶段测试数 9 条。

**读路径的显式切换推迟到阶段 4**，原因：迁移期 `image_urls` 已经镜像了 asset 的本地路径，展示等价；显式切换只有在阶段 4「同步不再写 `image_urls`」时才有意义，现在改只会增加风险。

#### 2.6 真机验证（iPhone 18 Pro / iOS 27，2026-09-13）

- App 正常启动，列表与图片显示与改造前一致；
- 读取模拟器容器内 AsyncStorage 确认迁移真实执行：
  - `trip-footprints.assets`：**19 条 asset**，字段完整（`remoteKey` 指向历史对象、`fetchStatus=0` 表示本地无 blob、`syncTime=0` 待校验）；
  - `trip-footprints.assetsMigratedAt`：`2026-09-12T21:11:46.279Z`（幂等标记已写入）。
- 结论：**历史记录已被成功登记为 asset，且未改动任何现有显示行为**。

**下一步**：阶段 3（远端 `trip_sync_items` 表 + `SupabaseFileApiDriver`）。

### 2.4 验证

- 手动：新增/编辑/删除/预览正常，杀进程重启后仍在；
- 迁移：构造一条只有 `image_urls` 的旧记录，启动后应生成 asset 且图片可见；
- `npx jest`：新增迁移单测（本地路径 → asset、远端 URL → asset）通过。

---

## 阶段 3：Supabase driver + 远端表

### 3.1 新表 SQL（`docs/supabase/trip-sync-items.sql`）

```sql
create table if not exists trip_sync_items (
  path             text primary key,   -- '<32位hex>.md' 或 'resources/<32位hex>'
  item_id          text not null,
  type_            int  not null,      -- 1=记录 2=资产元数据 9=资源
  body             text,
  jop_updated_time bigint not null,
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz
);
create index if not exists trip_sync_items_updated_idx on trip_sync_items (updated_at);

alter table trip_sync_items enable row level security;
drop policy if exists "own sync items" on trip_sync_items;
create policy "own sync items" on trip_sync_items for all
  using (auth.uid()::text = split_part(path, '/', 1))
  with check (auth.uid()::text = split_part(path, '/', 1));
```

> 说明：`updated_at` 必须由服务端 `now()` 写（`before update` 触发器或 upsert 时不传该列），否则 `basicDelta` 的时序会错乱。
> id 规则：新增记录一律用 32 位 hex；旧的 `footprint_…` 做一次性映射（`legacy_id → hex_id`，旧 id 存进 body）。

### 3.2 `src/sync/supabase/fileApiDriver.ts` 方法实现

方法集参照 `file-api-driver-joplinServer.ts`（309 行）：

| 方法 | 实现要点 |
| --- | --- |
| `initialize()` | no-op |
| `supportsMultiPut` / `supportsMultiDelete` / `supportsAccurateTimestamp` / `supportsLocks` | `false` |
| `requestRepeatCount()` | `3` |
| `stat(path)` | 查 `trip_sync_items`（path/updated_at/deleted_at）→ 映射成 `ItemStat` |
| `list(path)` | 按前缀查（`resources/%` 或 `''`）→ `{ items, hasMore: false, context: null }` |
| `get(path)` | 元数据项 → 返回 `body`；`resources/<id>` → `supabase.storage.download(remoteKey)` |
| `put(path, content, options)` | 元数据项 → `upsert trip_sync_items`；`options.source === 'file'` → 调 `uploadAssetBlob()` |
| `delete(path)` | 写墓碑 `deleted_at = now()`，不物理删 |
| `mkdir` / `format` / `clearRoot` / `move` | no-op 或抛「不支持」 |
| `delta` | **必须实现**（`FileApi.delta()` 是直接委托 `driver_.delta()`，不会自动兜底）：在内部调用 vendored 的 `basicDelta(path, getStatFn, options)`，`getStatFn` 返回「相对于 path 的项列表」——做法照抄 `file-api-driver-memory.ts:216-232` |
| `acquireLock` / `releaseLock` / `listLocks` | 不定义（`supportsLocks = false` 时不会被调用） |

blob 上传（等价于 Joplin 的 `shim.uploadBlob`，也是我们已实测可行的方式）：

```ts
async function uploadAssetBlob(localUri: string, remoteKey: string, mime: string, token: string) {
  const info = await FileSystem.getInfoAsync(localUri);
  const size = (info as { size?: number }).size ?? 0;
  if (!info.exists) throw new JoplinError(`File not found: ${localUri}`, 'fileNotFound');
  if (size <= 0) throw new JoplinError(`Empty local file: ${localUri}`, 'localBlobMissing');

  const url = `${SUPABASE_URL}/storage/v1/object/trip-footprint-images/${remoteKey}`;
  const result = await FileSystem.uploadAsync(url, localUri, {
    httpMethod: 'POST',
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': mime,
      'Content-Length': String(size),
      'x-upsert': 'true',
      'cache-control': 'max-age=31536000',
    },
  });
  if (result.status >= 400) throw new JoplinError(result.body, result.status);

  // 上传后回读校验（沿用现有 listStoredSizes 逻辑）
  const storedSize = await getStoredObjectSize(remoteKey);
  if (storedSize !== size) throw new Error(`Uploaded object size mismatch: ${storedSize} !== ${size}`);
}
```

### 3.3 接线

```ts
export async function createSupabaseFileApi() {
  const fileApi = new FileApi('', new SupabaseFileApiDriver());
  fileApi.setSyncTargetId(SYNC_TARGET_ID);
  await fileApi.initialize();
  return fileApi;
}
```

### 3.4 验证（关键里程碑）

1. 设备 A 新增带图记录 → 同步 → 服务端出现 `trip_sync_items` 行 + storage 对象（size 非 0）；
2. 清空 App 本地数据（保留登录）→ 再同步 → **记录与图片都能拉回来**；
3. 连续两次同步，第二次 `basicDelta` 不重复拉已同步项；
4. 服务端把某对象 size 改成 0 → 再次同步能识别并修复。

---

## 阶段 3 执行记录（2026-09-13）

### 3.1 执行结果与一处方案修正

**修正**：原 SQL 注释写 `path = '<32位hex>.md'`，但 RLS 用 `split_part(path,'/',1)` 取用户 id —— 两者不兼容。最终采用**带用户前缀**的方案：

```
<user_id>/<32位hex>.md            -- 记录 / 资产元数据
<user_id>/resources/<32位hex>     -- 资源（blob）路径
```

这样 RLS 一条策略即可覆盖，且 Joplin 的 `isSystemPath()`/`pathToId()` 只看最后一段，仍然成立（这也是 driver 内部做 path 前缀翻译的原因）。

另加一个触发器，保证 `updated_at` 由服务端写入（basicDelta 依赖它单调递增）：

```sql
create trigger trip_sync_items_touch
  before insert or update on public.trip_sync_items
  for each row execute function public.trip_sync_items_touch();
```

已在服务器执行并核验：`\d trip_sync_items` 显示 path/item_id/type_/body/jop_updated_time/updated_at/deleted_at + 主键 + updated_at 索引；`relrowsecurity = t`；策略 `trip sync items are user owned`（authenticated，USING + WITH CHECK）；触发器 `trip_sync_items_touch` 存在。

### 3.2 / 3.3 执行结果与两处修正

产出：

| 文件 | 说明 |
| --- | --- |
| `src/sync/supabase/syncBackend.ts` | `SyncBackend` 接口 + `createSupabaseSyncBackend()`（表读写、墓碑、`uploadBlob`/`downloadBlob`）；`uploadBlob` 用 `FileSystem.uploadAsync` 直传并**回读 size 校验** |
| `src/sync/supabase/fileApiDriver.ts` | `SupabaseFileApiDriver`：path 前缀翻译、`stat/list/get/put/delete`、`delta()` 内部调用 vendored `basicDelta` |
| `src/sync/supabase/fileApiFactory.ts` | 新增 `createSupabaseFileApi()`（取当前会话用户 → 建 driver → `FileApi('', driver)`） |
| `src/sync/mimeTypes.ts` | 纯函数 `contentTypeForObjectKey`（从 driver 依赖里剥离 Supabase） |

**修正 1（分层）**：driver 原本从 `syncBackend` 导入 `contentTypeForObjectKey`，导致 driver 间接依赖 supabase-js/AsyncStorage，Jest 直接报 `NativeModule: AsyncStorage is null`。已把该纯函数抽到 `src/sync/mimeTypes.ts`，driver 只保留**类型导入** `SyncBackend`，保持无 I/O 依赖。

**修正 2（语义）**：`resources/<id>` 对应 Storage 里的 blob，**不是表里的行**；`get(path, {target:'file'})` 必须先判断资源路径再去下载，否则会被"表里没有该行"挡住。另外 `list()` 的 items 需要带 `id`（vendored 类型 `RemoteItem` 要求）。

### 3.4 验证结果

单元测试（`src/sync/__tests__/fileApiDriver.test.ts`，7 条，全通过）：

- put 后库里 path 带 `<user_id>/` 前缀（RLS 前提）；
- stat/get/list 返回 Joplin 形状的相对路径；
- delete 写墓碑：stat 返回 null、basicDelta 报 `isDeleted`；
- basicDelta 复用 context 不重复返回；
- `put(source=file)` 走 blob 上传，object key = `<user>/assets/<name>`；
- 服务端 0 字节时抛错（不允许静默成功）；
- `get(target=file)` 从 Storage 下载到指定路径。

真实服务器集成测试（`src/sync/__tests__/fileApiDriver.integration.test.ts`，默认跳过）：

```bash
TRIP_SYNC_INTEGRATION=1 npx jest src/sync/__tests__/fileApiDriver.integration.test.ts
# ✓ 1 passed（4.9s）
```

断言覆盖：真实 `trip_sync_items` 落库（直接查表校验 body 与 `updated_at` 非 0，即触发器生效）→ `get`/`stat` 正常 → basicDelta 首次能看到该项、复用 context 第二次不再返回 → `delete` 后 `stat` 为 null → 测试结束清理数据（当前表内 0 行）。

**本阶段边界**：「上传带图记录 → 清空本地 → 拉回来」这条端到端里程碑依赖阶段 4 把资产同步接进 App；blob 直传（`FileSystem.uploadAsync`）此前已在真机上验证过 991 KB / 11.37 MB 两个尺寸，阶段 4 会用新引擎再跑一遍完整 E2E。

### 测试基础设施改动

- 新增 `jest.config.js`：基于 `jest-expo/jest-preset` 扩展 `setupFiles`（**不能直接覆盖 preset 的 setupFiles**，否则 RN 的 jest 环境会丢）。
- 新增 `jest.setup.js`：全局安装 AsyncStorage 官方内存 mock；读取 `.env` 注入 `EXPO_PUBLIC_*`（Expo 运行时注入，Jest 不会）。
- 失败用例的退避重试会耗时约 12 秒：测试里用 vendored `FileApi` 提供的 `requestRepeatCount_ = 0`（上游标注为测试用途）关闭重试。

当前全量：`npx tsc --noEmit` = 0 错误；`npx jest` = **32 通过 / 1 跳过**（集成测试仅在显式开启时运行）。

**下一步**：阶段 4（资产队列 + 增量，把新引擎接进 `manualSync`）。

---

## 阶段 4：资产队列 + 增量

### 4.1 `src/sync/assetQueue.ts`（三条判定照抄）

```ts
// 1) 只有内容变了才上传（Synchronizer.ts:785 等价）
const shouldUpload = (asset: Asset) =>
  !asset.remoteKey || asset.syncTime < asset.blobUpdatedTime || asset.forceSync;

// 2) 没有本地字节就拒绝上传（Synchronizer.ts:735-767 等价）
const canUpload = async (asset: Asset) => {
  if (asset.fetchStatus !== ASSET_DONE) return false;
  const info = await FileSystem.getInfoAsync(localPathOf(asset));
  return info.exists && (info as { size?: number }).size === asset.size;
};

// 3) 上传前 stat 设 Content-Length、上传后回读校验（file-api.ts:404 与 JoplinServerApi.ts:220 等价）
```

失败：写 `fetchError`，用 `tryAndRepeat` 退避（1s → 4s → 7s…，即 Joplin 的 `1 + n*3`）。

### 4.2 接进现有同步入口

`src/sync/manualSync.ts` 调整为三步：

1. `syncFootprintMetadata()`：记录级（保留现有 `trip_footprints` 路径，作为旧版本兼容读模型）；
2. `syncAssets()`：资产级，走 `fileApi` + `assetQueue`；
3. 保留现有 `repairEmptyUploadedImages()` 作为对账兜底（已验证可用）。

### 4.3 并发与调度

- 并发上限用 vendored `TaskQueue`（`Setting` 已替换为 `3`）；
- 触发源（启动 / 网络恢复 / 手动同步）用 vendored `AsyncActionQueue` 去抖合并；
- 游标：`basicDelta` 返回的 `context` 存 `trip-footprints.syncContext.<target>`。

### 4.4 验证

沿用现有 E2E 矩阵：断网恢复、杀进程继续、11 MB 大图、多图、重复同步幂等、本地文件缺失、服务端 0 字节注入。

---

## 阶段 4 执行记录（2026-09-13）

### 产出

| 文件 | 说明 |
| --- | --- |
| `src/sync/assetQueue.ts` | `runAssetSync({ fileApi, userId, syncTargetId })`：上传待同步图片 → 发布 `<assetId>.md` 元数据 → 远端有元数据而本地缺图时下载恢复；三条判定照抄 Joplin（内容未变不上传 / 本地无字节拒绝上传 / 上传后校验） |
| `src/sync/manualSync.ts` | 接入资产级同步（记录级 → 修复兜底 → 资产级），结果里新增 `uploadedAssets` / `downloadedAssets` / `failedAssets`；资产队列整体异常不影响记录级同步 |
| `app/index.tsx` | 同步完成弹窗显示「图片：上传 N 张，恢复 M 张（K 张待重试）」 |
| `src/sync/__tests__/assetQueue.test.ts` | 4 条测试：上传+发布、本地缺字节拒绝上传、二次运行不重复上传/发布、清空本地后能恢复 |

### 4.3 并发与调度

- 并发上限用 vendored `TaskQueue`（`setConcurrency(3)`），并已验证 vendored `TaskQueue` 在 RN/Jest 下可用。
- 游标：`basicDelta` 返回的 context 持久化在 `trip-footprints.syncContext.<syncTargetId>`。
- **偏差（有意）**：`AsyncActionQueue` 暂未接线。它的用途是「合并多个触发源（启动 / 网络恢复 / 手动同步）」，而当前产品只有手动同步一个触发源，且 `app/index.tsx` 已有 `syncing` 状态防重入；等将来加自动同步触发源时再接（计划保持不变）。

### 执行中发现并修正的问题

**发布 pass 误判**：最初用 `basicDelta` 的返回结果判断「远端是否已有元数据」。但 delta 只返回**自上次游标以来变化**的项，于是每次同步都会把已存在的元数据重发一遍（服务端 `updated_at` 被无意义刷新，实测从 21:48:01 被改到 21:48:12）。已改为对每个资产单独 `fileApi.stat('<assetId>.md')` 判断存在性（1 次请求/资产），并在单测里加了 `second.published === 0` 断言。

### 4.4 真机 E2E 结果（iPhone 18 Pro / iOS 27，真实服务器 + 真实 Storage）

临时 harness 驱动（验证后已删除），全部检查通过：

| 步骤 | 结果 |
| --- | --- |
| 造记录 + asset（编辑器同路径） | `PASS asset 已建立且本地可见` |
| sync #1 | `uploadedAssets: 1`，`remoteKey = <user>/assets/994320c32834add918845c1d9aea80bd` |
| Storage 对象探测 | `PASS`，HTTP 200 / **991,481 字节** |
| 清空本地（记录 + assets + 游标 + 本地文件，保留登录） | — |
| sync #2（恢复） | `downloadedAssets: 1`；`PASS 记录已从服务器恢复`、`PASS asset 已恢复 {size: 991481}`、`PASS 恢复的本地文件存在` |
| sync #3（幂等） | `PASS 重复同步不再上传`、`PASS 重复同步不再下载` |

服务端权威核对：

```
trip_sync_items: 3 行形如 <user>/<32hex>.md（item_id=<32hex>, type_=2, body=资产元数据 JSON）
storage: 3 个 <user>/assets/<32hex> 对象，大小 991,481 字节
元数据行 updated_at 在首次上传后不再变化（发布 pass 修复生效）
```

### 尚未覆盖（记录在案，留待阶段 5 或后续）

- 断网恢复 / 杀进程继续：资产级重试依赖 `fetchError` + 下次手动同步重试；未做网络状态自动触发。
- 本地文件被删除（游标未清）时不会重新下载：这是 basicDelta 增量语义的正常结果（Joplin 同样按需下载）；只有清空本地（游标一并清空）才会全量恢复。
- 远端删除资产（墓碑）在本地侧的联动删除尚未实现，当前只在增量结果里被忽略。

#### 4.4 补充矩阵执行结果（2026-09-13，第二轮真机 E2E）

| 场景 | 结果 |
| --- | --- |
| 多图（3 张，同源去重后 2 个 asset） | `PASS`，全部拿到 `remoteKey` |
| 大图 11,372,790 B | `PASS`，远端大小与本地**逐字节一致** |
| 本地字节损坏（写空）→ 同步 | `PASS`：`failedAssets: 1`、无 `remoteKey`、`fetchError` 已记录，**同步整体仍然成功** |
| 修复本地文件 → 再次同步 | `PASS`：`uploadedAssets: 1`、拿到 `remoteKey`、远端 991,481 B |
| 重复同步幂等（第一轮） | `PASS`：不再上传、不再下载 |
| 清空本地 → 恢复（第一轮） | `PASS`：记录与图片都恢复 |

**执行中发现并修复的真 bug（重要）**：第一轮矩阵里「失败 → 修复 → 重试」是**失败**的——`listAssetsNeedingUpload()` 只挑 `fetchStatus === DONE` 的资产，而被标记为 ERROR 的资产从此再也不会进入队列；同时 `canUploadAsset()` 也把 ERROR 直接判为不可上传。等于**一次失败就永久卡死**。已修正为：

- 队列条件改「没有 `remoteKey` 且不是正在上传（STARTED）」，失败项重新参与；
- `canUploadAsset()` 只看**本地文件**是否存在且大小一致（不再依赖 `fetchStatus`）。

修复后新增单测「上传失败后，本地文件恢复即可重试成功」，并重跑真机矩阵全绿。

**关于「杀进程继续」**：上传期间不写 STARTED 状态（进程被杀后资产仍是 DONE 或 ERROR），因此下次启动同步会自然重试，属于设计内行为；未单独做进程杀死的 E2E。

**下一步**：阶段 5（对账脚本 + GC 策略 + 体验层）。

---

## 阶段 5：对账、GC 与体验

### 5.1 `scripts/audit-assets.mjs`

输出四类问题：

1. 远端对象 `size = 0`；
2. 远端对象存在但没有任何 `trip_sync_items` 引用；
3. 本地有 asset 但远端无对象；
4. 远端有对象但本地 `remoteKey` 为空。

### 5.2 GC

```sql
delete from trip_sync_items
where deleted_at is not null and deleted_at < now() - interval '30 days';
```

storage 侧按引用关系清理孤儿对象（脚本逐条比对，不直接删目录）。

### 5.3 体验层

- 图片级状态：`local / uploading / uploaded / failed`，列表卡片角标显示；
- 同步完成弹窗增加「N 张待上传 / 已修复 N 张」；
- 列表缩略图：`…/render/image/public/trip-footprint-images/<key>?width=400&quality=70`（服务端 imgproxy 已开启）。

---

## 阶段 5 执行记录（2026-09-13）

### 5.1 对账脚本

新增 `scripts/audit-assets.mjs`（Node CLI，凭据只从环境变量读，不写进仓库）：

```bash
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/audit-assets.mjs [--json]
```

它用 Storage API 递归列出 bucket 对象 + PostgREST 读 `trip_sync_items` / `trip_footprints`，输出四类问题：0 字节对象、孤儿对象、元数据指向的对象缺失、大小不一致；有问题时退出码为 1（便于接 CI）。

**实跑结果（真实服务器）**：

```
对象 39 个，其中被引用 39 个；元数据资产 3 个；足迹记录 24 条
1) 0 字节对象：14        <- 历史上传 bug 的遗留（含用户正式账号 10 个）
2) 孤儿对象：0
3) 元数据指向的对象不存在：0
4) 大小不一致：0
exit=1
```

客户端侧新增 `src/local/repositories/assetAudit.ts`（`auditLocalAssets()` / `summarizeAssetIssues()`）：检查「本地有 asset 但无 remoteKey」「本地文件缺失」「大小不一致」，并加了单测。

### 5.2 GC 策略

新增 `docs/supabase/trip-sync-items-gc.sql`，四段体检 SQL（墓碑、孤儿对象、0 字节对象、元数据一致性）。

**执行决策：对象清理保持「只体检、不自动删」**。原因：迁移期仍存在旧路径引用（`trip_footprints.image_url(s)` 指向 `<user>/<footprint>/<n>-<hash>.<ext>`），自动 GC 有误删用户图片的风险。墓碑清理（30 天）给出了可直接执行的删除语句。

### 5.3 体验层

| 项 | 实现 |
| --- | --- |
| 图片级状态 | `listFootprintIdsWithPendingAssets()` + 列表卡片「图片待上传」角标（`FootprintScreen.tsx`、`styles.pendingBadge`） |
| 同步弹窗 | 阶段 4 已加：「图片：上传 N 张，恢复 M 张（K 张待重试）」 |
| 列表缩略图 | `thumbnailUrlFor()` 把 `object/public/…` 改写成 `render/image/public/…?width=400&quality=70`；单测覆盖 |

缩略图端点实测：同一张图原图 991,481 B → `width=400&quality=70` 后 **154,081 B**（约 1/6）。

### 执行中发现并补齐的问题（重要）

**推迟到阶段 4 的「读路径切换」在这里暴露并补齐了。** 阶段 4 的 E2E 之后，模拟器里两条记录显示为**灰块**：它们的 `image_urls` 镜像的是本地文件路径，而本地文件在 E2E 的「清空本地」步骤被删掉了，虽然远端 asset 存在，但展示路径仍然只读记录字段。

修复：新增 `resolveFootprintImageUris(footprintId, fallbackUris)`（asset 优先：本地文件在→用本地；否则用远端对象；没有 asset 时才回退到记录里的 `image_urls`），并在 `FootprintScreen` 与 `FootprintAlbumScreen` 的加载流程里接入。

验证：同一份数据重新启动 App 后，两条记录都从远端 asset 正常显示图片（此前是灰块）；期间没有改动记录字段。至此阶段 2.3 的读路径改造完整落地。

### 阶段 5 完成后的全量状态

```
npx tsc --noEmit   -> 0 错误
npx jest           -> 40 通过 / 1 跳过（真实服务器集成测试默认跳过）
node scripts/audit-assets.mjs -> 0 字节 14（历史遗留，可在设备上自愈）、孤儿 0、缺失 0、大小不一致 0
```

**计划内的五个阶段到此全部完成。** 仍记录在案的后续可选项：断网/杀进程自动重试、远端删除的本地联动、将 `image_urls` 完全退役（需要旧版本客户端升级窗口）。

---

## 收尾批次（2026-09-13，把上面的「后续可选项」全部做掉）

### A. 自动重试 + AsyncActionQueue 接线（补全 4.3）

新增 `src/sync/assetAutoRetry.ts`：

- `startAssetAutoRetry()` 在根布局调用一次：**启动时**与**从后台回到前台**（`AppState`）各触发一次；
- 多个触发由 vendored `AsyncActionQueue`（100ms 去抖）**合并成一次执行**；
- 只跑**资产队列**（上传/下载/删除），不做记录级合并——记录同步仍由用户手动触发（保持产品语义）；
- 没有待上传资产时直接返回，不发请求；失败静默，等下一个触发源。

至此计划 4.3 的「AsyncActionQueue 去抖合并触发源」不再是有意偏离，已落地。测试：`assetAutoRetry.test.ts` 2 条（合并成一次、无待上传时不发请求）。

### B. 远端删除的本地联动

`runAssetSync` 现在会处理 `basicDelta` 返回的 `isDeleted` 项：远端删除资产 → 删除本地 asset 行与本地文件，并计入 `deleted`。

**执行中修掉一个自己引入的缺陷（重要）**：最初把**全部**本地 asset id 交给 `basicDelta` 做「远端是否已删除」的比对，导致**从未上传成功**的资产（刚失败的那种）被误判为「远端已删除」，本地副本被清掉——单测立刻变红。已按 Joplin 的语义修正为**只把「曾经同步成功过」（`remoteKey` 存在或 `syncTime > 0`）的资产纳入比对**（对应上游 `models/BaseItem.ts` 的 `remoteItemMetadata` 只取 `sync_time > 0`）。

测试：`assetQueue.test.ts` 新增「远端删除资产后，本地副本会被清理」。

### C. 镜像字段稳定化（记录里不再存设备相关的本地路径）

- 新增 `mirrorUrisForFootprint()`：镜像优先写**远端公共 URL**（稳定、换设备/清数据后仍有效），未上传时才退回本地路径；
- `rebuildAssetsForFootprint()` 同步采用该规则；
- `runAssetSync` 返回 `touchedFootprintIds`，`manualSync` 在资产阶段之后调用 `refreshFootprintMirrors()`，只在**确实变化**时写回记录（避免无谓刷新 `updated_at`）。

测试：`assetRepository.test.ts` 新增「镜像字段：未上传时是本地路径，上传后变成稳定的远端 URL」。

### D. GC 脚本

新增 `scripts/gc-assets.mjs`：默认**试运行**，`--apply` 才执行；清理超过 N 天（默认 30）的墓碑项 + 孤儿对象（对象删除走 Storage API，同时清掉 DB 行）。已被任何记录引用的对象不会被删。

试运行实测：`墓碑 0 / 孤儿 0`（与对账脚本一致）。

### E. 测试数据清理

把本轮 E2E 在测试账号（`codex.trip.probe`）下产生的数据全部清理：

- 服务器：删除 34 个 Storage 对象、19 条 `trip_footprints`、15 条 `trip_sync_items`（严格按该账号 user_id 限定，未触碰你正式账号）；
- 模拟器：清空 App 本地业务数据与本地图片，仅保留登录态。

清理后的服务器现状（对账脚本实测）：

```
对象 17 个（全部被引用）；足迹记录 5 条（你正式账号的）；0 字节对象 10 个
孤儿 0；元数据缺失 0；大小不一致 0
```

这 10 个 0 字节对象就是你正式账号那两条记录里的图片，会在你设备用新版本同步时由「老数据修复」逻辑自动重传。

### 收尾批次后的最终验证

```
npx tsc --noEmit                        -> 0 错误
TRIP_SYNC_INTEGRATION=1 npx jest        -> 46 / 46 通过（含真实服务器集成测试）
node scripts/audit-assets.mjs           -> 孤儿 0、缺失 0、大小不一致 0
node scripts/gc-assets.mjs              -> 试运行：墓碑 0、孤儿 0
模拟器（iPhone 18 Pro / iOS 27）         -> App 正常启动，列表为空（数据已清理），图片同步管线为 Joplin 式资产模型
```

---

## 彻底退役 `image_url` / `image_urls`（2026-09-13）

### 服务端

1. **备份**：`public.trip_footprints_image_backup_20260913`（5 行 id + 图片字段快照）。
2. **回填**：把旧字段指向的 Storage 对象登记成 `trip_sync_items` 资产元数据项 → **INSERT 0 10**
   （`docs/supabase/trip-footprints-retire-image-columns.sql` 第 1 步；资产 id = `md5(object_key)` 前 32 位，满足客户端 `isSystemPath()` 的 32 位 hex 规则）。
   - 三条 `superme-*` 记录因 `deleted_at` 非空被正确跳过（已删除记录不迁）。
3. **删列**：`alter table public.trip_footprints drop column image_url / image_urls;`
   - 现在表结构：`id, user_id, location, coordinate, visit_date, notes, rating, created_at, updated_at, deleted_at`。

> 注意：仍是旧版本的客户端会因为缺列而同步失败（本地数据不受影响）。**设备需要先升级到新版本**。

### 客户端

| 位置 | 改动 |
| --- | --- |
| 编辑器保存 | 记录只写元数据（`location/coordinate/visit_date/notes/rating`），图片全部由 asset 承担 |
| 编辑器编辑 | 表单图片来自 `mirrorUrisForFootprint()`（asset：远端 URL 或本地路径），不再读记录字段 |
| 同步（`manualSync`） | 移除「记录级图片上传」与「镜像字段刷新」；记录级只 upsert 元数据；远端 select 不再包含图片列 |
| 展示 | 继续走 `resolveFootprintImageUris()`（asset 优先） |
| 0 字节修复 | 改为**基于 asset** 的 `repairEmptyAssetObjects()`：新命名用资产自己的文件、旧命名按对象名里的 hash 反查本地文件，重传同一个对象 key |

### 仍然保留的只读兼容（有意为之）

- `assetMigration.ts`：读**本地**记录的 `image_urls`（老设备首次升级时用来把历史图片登记成 asset）。
- `footprintImageFiles.repairFootprintImageReferences()` 与展示层 `footprintImageUris()` 的兜底：只读，不再写入。
- 这三处是给「还没升级到新版本的设备」留的桥；等所有设备都升级并可确认无旧数据后可再删。

### 退役验证

真机 E2E（编辑器保存不写图片字段 → 资产上传/发布 → 远端 991,481 B → 编辑器回填拿到稳定远端 URL）：`=== ALL CHECKS PASSED ===`。

真实服务器集成测试 `manualSync.integration.test.ts`：本地塞一条 pending 记录 → `runManualSync()` → 线上 `trip_footprints` 用**新列集合**查询能取回该记录（证明应用与退役后的表结构一致）。

### 对账脚本适配

`image_url` 退役后，对象引用关系只来自 `trip_sync_items` 的 `remoteKey`。两个脚本已同步更新并抽出共用层 `scripts/lib/syncStore.mjs`。当前试运行结果：孤儿 7 个（都属于**已删除记录**的旧图，可清理但保留待确认）、墓碑 0。

### 退役后的最终验证

```
npx tsc --noEmit                        -> 0 错误
TRIP_SYNC_INTEGRATION=1 npx jest        -> 39 / 39 通过（含 2 条真实服务器集成测试）
node scripts/audit-assets.mjs           -> 0 字节 10（待设备自愈）、孤儿 7（已删除记录的旧图）、缺失 0、大小不一致 0
node scripts/gc-assets.mjs              -> 试运行：墓碑 0、孤儿 7
```

---

## 全面核验轮（2026-09-13，用户要求「再全面核验一次」）

### 1. 死代码审计

- `grep` 确认已删除模块（`footprintImageStorage` / `uploadFootprintImagesForSync` / `repairEmptyUploadedImages` / 两个错误类）**无任何残留引用**（只剩一条注释提到旧文件名）。
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`（排除 vendored 目录）→ **0 处未使用**；过程中清掉：
  - 测试里未使用的导入 2 处、`assetAudit` 未使用的类型导入 1 处；
  - `footprintsRepository.markFootprintFailed()`：记录级同步已不再有「按记录标记失败」的语义，导出已删除。
- 文件清单复核：`src/` 下无孤儿模块（删掉的老上传模块与对应测试文件已不存在）。

### 2. 综合核验 harness（真机，12 项）

| 项 | 检查 | 结果 |
| --- | --- | --- |
| A | 编辑器路径建立 asset，记录不含图片字段 | PASS |
| B | 未同步时出现在「待上传」列表 | PASS |
| C | 记录同步成功 + 资产上传并发布元数据项 | PASS |
| D | 远端对象大小 == 本地（991,481 B） | PASS |
| E | 同步后不再出现在「待上传」列表 | PASS |
| F | 展示解析：本地文件优先；编辑回填为稳定远端 URL | PASS |
| G | 本地文件损坏 → 失败标记（无 remoteKey + 错误原因）；修复后重试成功 | PASS |
| H | 清空本地（记录+资产+游标+文件）→ 记录与图片全部恢复（downloaded=2） | PASS |
| I | 自动重试（`runAssetRetryNow`）无需手动同步即完成上传 | PASS |
| J | 缩略图 URL 走 imgproxy（`/render/image/public/…?width=400`） | PASS |

结果：`=== 全部核验通过 ===`（空失败列表）。

### 3. 服务端核对（权威）

```
trip_footprints 列：id,user_id,location,coordinate,visit_date,notes,rating,created_at,updated_at,deleted_at   （无图片列）
探针账号：记录 5 条、同步项 5 条（一一对应）
同步项示例：<user>/<32hex>.md | size=991481 | remoteKey=<user>/assets/<32hex>
对象：5 个，全部 991,481 B
```

### 4. 本轮发现并修复的两个真实 UI 缺陷

真机截图暴露：同步后新增的记录**不显示图片**（数据层完全正常，是刷新问题）。两个根因：

1. **列表只在 `load()` 解析 asset URI**，仓库订阅回调里只更新记录，不重新解析 → 记录新增/资产变化后展示为空；
2. 更本质的：**资产变化没有变更通知**（记录有 `subscribeFootprintsLocal`，资产没有对应订阅）→ 「记录已插入、asset 随后才建立」时，UI 永远停在空 URI 状态。

修复：

- 新增 `subscribeAssetsLocal()`（`assetRepository` 的 `persistAssets` 广播），并加单测「资产变化会通知订阅方」；
- `FootprintScreen` 同时订阅记录与资产变化，统一刷新展示 URI + 「待上传」角标；
- 抽出 `refreshResolvedAssetUris()` 供 `load()` 与两个订阅共用。

验证：修复前「核验-自动重试」卡片无图 → 修复后有图（截图对比）；此后所有核验项仍全部通过。

### 5. 核验轮之后的最终状态

```
npx tsc --noEmit                        -> 0 错误
npx jest                                -> 38 通过 / 2 跳过
TRIP_SYNC_INTEGRATION=1 npx jest        -> 40 / 40 通过
真机综合核验                            -> A~J 全部 PASS
```

---

## 真机复查：用户正式账号为何仍是灰图（2026-09-13）

**现象**：在模拟器登录正式账号（`631911727@qq.com` / `3c7c8470-…`）后，两条记录的图片仍是灰块。

**排查结论（三个独立问题，已全部修复）**

1. **数据本身是空的（根因）**：服务器上这 10 张图确实存在，但 `content-length: 0`、ETag 是空串的 MD5 —— 就是历史上传 bug 留下的空对象。修复只能从「拍摄这些照片那台设备上的本地原图」重传，而**模拟器上从来没有这些原图**，所以在这里无法修复（预期行为）。

2. **「只跑一次」的修复标记会被过早置位**：旧逻辑在第一次同步时若找不到候选资产（资产还没从服务器同步下来）就直接写入 `images_verified_at`，导致之后再也不会尝试修复。已改为**每次同步都尝试**（代价仅是每个目录一次 `list`），并把修复挪到资产同步**之后**。

3. **下载与修复都缺少内容校验**（核验时实际撞到）：
   - 下载只判断"文件存在且非 0 字节"，于是 **404 的 JSON 响应体被当成图片存了下来**（实测 69 字节的 `{"statusCode":"404",...}`）；
   - 修复上传前也不校验本地文件，于是把这份 JSON **又传回了服务器**（我在核验过程中触发了它，已把那 10 个对象删除，恢复为"对象不存在"状态，等待设备用真原图重建）。
   - 现在三处都加了**文件头魔数校验**（`imageValidation.ts`：JPEG/PNG/GIF/WebP/HEIC，基于真实字节解码而非字符串启发式）：上传前、下载后、修复前都会验证；失败时删除无效文件并记录失败原因。

**界面表现（已改善）**：这些资产现在带 `fetchError`，列表卡片显示「图片待同步」角标 + 记录失败原因，而不是静默灰块——同步完成弹窗也会把失败张数报出来。

**用户需要做什么**：在**留有原图的那台手机**上安装新版本 → 手动同步一次 → 那 10 张图会自动重传修复。若手机上的原图也已丢失（例如重装过且未备份），这些图片无法恢复，需要重新选图补录。

---

## 本地模式（2026-09-13 新增）

设置页新增「本地模式」开关：开启后图片只保存在本机，不做任何上传。

实现要点（**不只是隐藏按钮**，上传路径被阻断）：

| 位置 | 行为 |
| --- | --- |
| `src/local/repositories/appSettingsRepository.ts` | 设置持久化（`trip-footprints.settings`）+ 变更订阅 |
| `src/features/settings/SettingsScreen.tsx` | 「本地模式」开关（`Switch`），说明文案「图片只保存在本机，不再上传；同步入口会隐藏」 |
| `app/index.tsx` | 开启后 `rightAction` 不再渲染同步按钮，改为不可点的 `cloud-offline-outline` 状态图标；`syncFootprints()` 入口处直接 return |
| `src/sync/assetAutoRetry.ts` | 启动/回到前台时直接跳过（否则会在后台偷偷上传） |
| `src/sync/assetQueue.ts` | `runAssetSync()` 入口防御性返回，不做上传/下载 |
| `src/sync/manualSync.ts` | 防御性抛错：「本地模式已开启：图片只保存在本机，不会上传。可在「设置 → 本地模式」中关闭。」 |

测试：`appSettingsRepository.test.ts`（默认关闭、切换后持久化并通知、重读生效）+ `assetQueue.test.ts` 新增「本地模式下不做任何上传或下载」。

模拟器验证：开启后列表头部同步按钮消失（换成离线云图标），设置页开关为开；关闭后同步按钮恢复。

---

## 附录 A：改动文件总览

| 阶段 | 新增 | 修改 |
| --- | --- | --- |
| 0 | `src/vendor/joplin/*`（8 个搬运 + 7 个替身 + README） | 无 |
| 1 | `src/sync/supabase/fileApiFactory.ts`、`src/sync/__tests__/fileApi.smoke.test.ts` | 无 |
| 2 | `src/local/repositories/assetRepository.ts`、`src/features/daily/footprints/assetResolver.ts` | 编辑器 / 列表 / 相册 / 预览 / `imageCache.ts` |
| 3 | `src/sync/supabase/fileApiDriver.ts`、`docs/supabase/trip-sync-items.sql` | `fileApiFactory.ts` |
| 4 | `src/sync/assetQueue.ts` | `manualSync.ts` |
| 5 | `scripts/audit-assets.mjs` | 同步弹窗、列表卡片 |

## 附录 B：每阶段回滚

| 阶段 | 回滚方式 |
| --- | --- |
| 0-1 | 删除 `src/vendor/joplin` 与相关测试，不影响现有功能 |
| 2 | asset 是新增数据；读路径加开关 `useAssets=false` 即回旧路径 |
| 3 | 关闭双写；旧 `trip_footprints` 路径仍在 |
| 4 | 关闭 `syncAssets()`，回退到当前 `uploadFootprintImagesForSync`（保留一个周期） |
| 5 | 只读脚本，无需回滚 |

## 附录 C：命令速查

```bash
npx tsc --noEmit
npx jest
npx jest src/sync/__tests__/fileApi.smoke.test.ts
npx expo start --port 8083
xcrun simctl launch booted com.qiuzizhao.tripfootprints
xcrun simctl io booted screenshot /tmp/x.png
```
