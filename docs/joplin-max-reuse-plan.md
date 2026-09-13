# 参考 Joplin 的 Trip 改造方案（最大程度复用代码与逻辑）

> 源码：`/tmp/joplin-src`（`packages/lib` + `packages/app-mobile`）。
> 范围：只改 Trip，**WorkLog 不动**。
> 目标：能直接搬的就搬，能直接用的逻辑就不重写。

---

## 0. 结论

Joplin 的 **`file-api.ts`（671 行）耦合度比预期低得多**：整个文件对重度模块的调用只有 **12 处**，替换掉就能整段复用，连同它的
`basicDelta`（增量算法）、fail-safe、重试、锁、分页一起拿到手。

因此推荐 **T2 路线**：vendor 约 2,430 行 Joplin 代码（实际编辑约 16 处），自研约 900 行适配层。

---

## 1. 三条路线对比

| | T1 整引擎复用 | **T2 传输/队列层复用（推荐）** | T3 只抄小件 |
| --- | --- | --- | --- |
| 复用内容 | `Synchronizer.ts`(1331) + `BaseItem`(1123) + `BaseModel`(797) + `JoplinDatabase`(1074) + `Setting`(1502) + 全部 models + 数据库迁移 + E2EE/分享/锁 | `file-api.ts`(671) + `basicDelta` + `AsyncActionQueue`(161) + `TaskQueue`(206) + `mime-utils`(838) + `JoplinError`(14) + `ArrayUtils`(100) + `time`(189) ≈ **2,430 行** | 约 130 行判定/重试小件 |
| 需要自己写 | 一个 Supabase driver（~300 行）+ 全套 RN polyfill（Joplin 移动端实际装了 10+ 个：crypto-browserify、buffer、stream-browserify…） | shim(40) + driver(300) + 资产队列(250) + 资产仓储(200) + 映射(150) ≈ **900 行** | 队列/编排/仓储/映射全部 ≈ 1,200 行 |
| 得到的逻辑 | 完整同步引擎（含冲突笔记、锁、E2EE、分享） | **增量 delta 算法、fail-safe 防误删、重试退避、锁、队列、mime 全套** | 只有状态判定 |
| 代价/风险 | 2~4 周，且必须接受 Joplin 的 schema 与概念（note/folder/resource） | 3~4 天，schema 是我们自己的 | 3~4 天，但核心算法要自己写 |
| 建议 | ❌ 私人自用不值 | ✅ | 备选 |

---

## 2. `file-api.ts` 的 12 处改造点（全部列出）

| 位置 | 现状 | 改法 |
| --- | --- | --- |
| 70-73 | `Setting.value('sync.target')` 判断 filesystem/webdav 本地服务器 | **删除**（我们不支持这两类目标） |
| 106、108 | `shim.fetchMaxRetrySet(0)` | 换成我们自己的 no-op（RN 的 fetch 本身没有内建重试） |
| 308 | `shim.fsDriver()` | 换成 RN fs 适配（expo-file-system） |
| 365 | `BaseItem.isSystemPath(f.path)` | 内联纯函数（10 行） |
| 523、556、559、634 | `BaseItem.isSystemPath()` / `pathToId()` / `systemPath()` | 同上，三个纯函数内联 |
| 647 | `sprintf(...)` | 换成模板字符串 |

其余 600+ 行（`delta`/`basicDelta`/`list`/`put`/`get`/`delete`/锁/重试/分页）**原样保留**。

被内联的三个函数（`models/BaseItem.ts:174-253`）原文：

```ts
systemPath(itemOrId, extension = 'md')  // `${id}.${ext}`
isSystemPath(path)                      // 32 位十六进制 + .md
pathToId(path)                          // 从 path 取 id
```

---

## 3. vendor 清单（源 → 目标）

| 源文件 | 行数 | 目标 | 改动 |
| --- | --- | --- | --- |
| `file-api.ts` | 671 | `src/vendor/joplin/fileApi.ts` | 上表 12 处 |
| `AsyncActionQueue.ts` | 161 | `src/vendor/joplin/asyncActionQueue.ts` | Logger→console；`shim.setTimeout/clearTimeout/setInterval`→全局 |
| `TaskQueue.ts` | 206 | `src/vendor/joplin/taskQueue.ts` | `Setting`→常量；Logger→console |
| `mime-utils.ts` + `mime-utils-types.ts` | 838 | `src/vendor/joplin/mime*.ts` | 无 |
| `JoplinError.ts` | 14 | `src/vendor/joplin/joplinError.ts` | 无 |
| `ArrayUtils.ts` | 100 | `src/vendor/joplin/arrayUtils.ts` | 无（按需） |
| `time.ts` | 189 | `src/vendor/joplin/time.ts` | 无（或只留 msleep/formatMs） |
| `resourceRemotePath.ts` | 5 | `src/vendor/joplin/resourceRemotePath.ts` | 无 |
| `models/BaseItem.ts:174-253` 三个纯函数 | 15 | `src/vendor/joplin/systemPath.ts` | 抽出来内联 |
| `file-api-driver-memory.ts` | 232 | `src/vendor/joplin/fileApiDriverMemory.ts` | `fs-extra`→去掉（仅一处）；**用作单测替身** |
| **合计** | **≈2,430** | | **实际编辑 ≈16 处** |

---

## 4. 需要自己写的适配层（5 个文件）

### 4.1 `src/vendor/joplin/shim.ts`（约 40 行）

只实现被 vendor 代码用到的最小面：

```ts
export default {
  isReactNative: () => true,
  fetchMaxRetrySet: (_n: number) => 0,       // 我们自己做重试
  fsDriver: () => rnFsDriver,                // expo-file-system 包装
  setTimeout, clearTimeout, setInterval, clearInterval,
  fetch: (url, options) => fetch(url, options),
};
```

### 4.2 `src/sync/supabase/fileApiDriver.ts`（约 250~300 行）

方法集参照 `file-api-driver-joplinServer.ts`（309 行，REST 版最接近我们的场景）：

| 方法 | 我们的实现 |
| --- | --- |
| `initialize` / `format` / `clearRoot` / `mkdir` | no-op 或极简 |
| `supportsMultiPut/MultiDelete/Locks` | `false`（私人自用不需要锁） |
| `requestRepeatCount()` | 3（配合 `tryAndRepeat`） |
| `stat(path)` / `list(path)` | 查 `trip_sync_items`，映射成 `ItemStat` |
| `get(path)` | 元数据项读 body；`resources/<id>` 走 storage 下载 |
| `put(path, content, { source: 'file' })` | 元数据项写表；blob 用 `FileSystem.uploadAsync` 直传 storage |
| `delete(path)` | 写 `deleted_at` 墓碑（不物理删） |
| `delta()` | **先返回 null** → `FileApi` 自动走 `basicDelta`（复用它的增量算法）；以后要优化再加原生 delta |
| `acquireLock/releaseLock/listLocks` | 不实现（`supportsLocks=false` 时不会被调用） |

配套表（新增，通用）：

```sql
create table if not exists trip_sync_items (
  path            text primary key,      -- '<id>.md' / 'resources/<id>'
  item_id         text not null,
  type_           int  not null,
  body            text,
  jop_updated_time bigint not null,
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);
create index if not exists trip_sync_items_updated_idx on trip_sync_items (updated_at);
```

### 4.3 `src/sync/assetQueue.ts`（约 250 行）

编排层，直接复用 Joplin 的三个判定（上一份清单 A3/A5/A6/A7）：

- 是否要传 blob：`!asset.remoteKey || asset.syncTime < asset.blobUpdatedTime || asset.forceSync`
- 本地字节不存在（`fetchStatus !== DONE` 或文件缺失）→ 标记 `cannot_sync`，跳过
- 上传前 `stat` 取 size 设 `Content-Length`；上传后回读 size 校验
- 失败 → `tryAndRepeat` + 退避；用 `AsyncActionQueue` 做去抖/串行，`TaskQueue` 限并发

### 4.4 `src/local/repositories/assetRepository.ts`（约 200 行）

资产表（`id/footprintId/position/fileName/size/mime/blobUpdatedTime/remoteKey/fetchStatus/fetchError/syncTime/forceSync`）+ 旧数据迁移。

### 4.5 映射层（约 150 行）

- footprint 记录 ↔ 同步项（`<id>.md`，body 为 JSON）
- 图片 ↔ resource（`resources/<asset_id>`，blob 在 storage）

---

## 5. 分阶段实施与验收

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| **0** | 建 `src/vendor/joplin/`，搬入清单文件，改 16 处调用点，`tsc` 通过 | `npx tsc --noEmit` 干净；vendor 目录无对外依赖 |
| **1** | 写 `shim.ts` + `FileApiDriverMemory` 跑通 `FileApi`（不接网络） | 复用 Joplin 的 `file-api.test.ts` 中 basicDelta 用例（裁剪后）全绿 |
| **2** | 本地资产模型 + 迁移 + 显示解析（旧字段只读兼容） | 本地新增/显示/编辑/删除正常；旧数据迁移不丢图 |
| **3** | Supabase driver + `trip_sync_items` + 双写；打通「上传 1 张图 → 清空本地 → 能拉回来」 | 真机/模拟器双设备场景验证 |
| **4** | 接入资产队列（A 组判定 + delta 游标） | E2E 矩阵：断网/杀进程/11 MB 大图/重复同步/本地缺文件/服务端 0 字节注入 |
| **5** | 对账脚本 + GC + 图片级状态 UI + 服务端缩略图 | `audit-assets` 报告为空 |

---

## 6. 可以直接复用的测试

- `file-api-driver-memory.ts`（232 行）作为 `FileApi` 的测试替身——不需要网络就能测 delta/分页/删除/lock 逻辑。
- `file-api.test.ts`（315 行）里的 `basicDelta` 用例（同毫秒边界、远端删除、分页）裁剪后可直接跑，这是最容易写错的部分。

---

## 7. 明确不做

| Joplin 有 | 决定 |
| --- | --- |
| `Synchronizer.ts` 全量（含冲突笔记、MasterKey、分享、E2EE、多 sync target） | 不做（T1） |
| 锁（`supportsLocks`） | 不做（单用户自用） |
| E2EE | 不做，字段留位 |
| OCR / 插件 / 搜索索引 | 不做 |
| DB 迁移系统（JoplinDatabase） | 不做，用我们自己的表 |

---

## 8. 风险

1. **`basicDelta` 的语义依赖 `updated_at` 单调递增**：Supabase 侧 `updated_at` 必须由服务端 `now()` 写入，不能用客户端时间。
2. **vendor 代码要标记来源与版本**（建议在 `src/vendor/joplin/README.md` 记录 commit 与来源行号），否则后续 Joplin 升级无法对照。
3. **两套路径并存期**：阶段 3 完成后旧上传路径保留一个同步周期用于回滚，随后删除，避免长期双写。
4. **`TaskQueue`/`AsyncActionQueue` 与 `p-queue` 功能重叠**：既然走了最大复用路线，就用 Joplin 的，不再引入 p-queue。
