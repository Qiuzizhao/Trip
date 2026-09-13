# 按 Joplin 的资源同步模型改造 Trip：实施方案

> 依据：Joplin 源码（`laurent22/joplin`，sparse checkout `packages/lib` + `packages/app-mobile`，2026-09-13 拉取）。
> 目标：把 Trip 的图片从「记录里的一个 URL 字段」改成 Joplin 式的「记录 + 资源」模型。

---

## 一、Joplin 是怎么做的（源码依据）

### 1. 记录与资源分成两张表

- `resources`（**参与同步的元数据**）：`id`、`mime`、`size`、`filename`、`file_extension`、`blob_updated_time`、`encryption_blob_encrypted`…
  `packages/lib/services/database/types.ts:302-328`
- `note_resources`（**关联表**）：`note_id` ↔ `resource_id`，带 `is_associated`、`last_seen_time`，用于判断孤儿资源
  `packages/lib/services/database/types.ts:223-230`

关键点：笔记正文里只是一个 `:/resource_id` 引用，**不存 URL**。

### 2. 传输状态是「本地表」，绝不参与同步

```ts
// packages/lib/models/Resource.ts:62-65
public static FETCH_STATUS_IDLE = 0;
public static FETCH_STATUS_STARTED = 1;
public static FETCH_STATUS_DONE = 2;
public static FETCH_STATUS_ERROR = 3;
```

`resource_local_states`（`resource_id`、`fetch_status`、`fetch_error`）是纯本地表（`packages/lib/models/ResourceLocalState.ts`）。
**这是最重要的一条**：每台设备的传输进度不上传服务器，否则多设备互相打架（我们现在的 `sync_status` 恰恰是同步字段）。

### 3. 只有「内容变了」才重新上传 blob

```ts
// packages/lib/Synchronizer.ts:779-786
// We skip updating the blob if it hasn't been modified since the last sync.
// In that case, it means the resource metadata (title, filename, etc.) has
// been changed, but not the data blob.
const syncItem = await BaseItem.syncItem(syncTargetId, resource.id, { fields: ['sync_time', 'force_sync'] });
if (!syncItem || syncItem.sync_time < resource.blob_updated_time || syncItem.force_sync) {
    await this.apiCall('put', remoteContentPath, null, { path: localResourceContentPath, source: 'file', shareId: resource.share_id });
}
```

判断依据是 **`blob_updated_time`**（文件内容）与该项**上次成功同步时间 `sync_time`** 的比较，而不是「记录被改过」。改标题、改文件名不会重传 7 MB 的原图。

### 4. 没有本地字节时，拒绝上传并标记「cannot sync」

```ts
// packages/lib/Synchronizer.ts:735-767
if (localState.fetch_status !== Resource.FETCH_STATUS_DONE) {
    logger.info(`Need to upload a resource, but blob is not present: ${path}`);
    await handleCannotSyncItem(ItemClass, syncTargetId, local, 'Trying to upload resource, but only metadata is present.');
    action = null;
}
```

即：**只有元数据、没有字节时，宁可不传，也不发空 body**——这正是我们这次踩的坑（0 字节对象），Joplin 用状态机把它挡住了。

### 5. 上传从「文件路径」流式发出，不经 JS 的 Blob

RN 端的实现（`packages/app-mobile/utils/shim-init-react/index.ts:134-156`）：

```ts
shim.uploadBlob = async function(url, options) {
    if (!options || !options.path) throw new Error('uploadBlob: source file path is missing');
    const response = await RNFetchBlob.config({ trusty: options.ignoreTlsErrors })
        .fetch(method, url, headers, RNFetchBlob.wrap(options.path));
    ...
};
```

用的是 **`react-native-blob-util`（RNFetchBlob）+ `wrap(path)`**：直接从磁盘按路径推字节。
配套两道校验：

- 上传前先确认文件存在：`file-api.ts:404-406` → `if (!(await this.fsDriver().exists(options.path))) throw new JoplinError(..., 'fileNotFound')`
- 用本地 `stat.size` 设置 `Content-Length`：`JoplinServerApi.ts:220-226`

对照我们：Trip 现在是 `fetch(file://).blob()`（已改为 `arrayBuffer`），Trip 的等价物就是 `FileSystem.uploadAsync(url, fileUri, …)`。

### 6. 增量同步 + 持久化游标

```ts
// packages/lib/Synchronizer.ts:890-935
const listResult: PaginatedList = await this.apiCall('delta', '', { ... });
...
// packages/lib/Synchronizer.ts:1168-1184
options.saveContextHandler({ delta: deltaToSave });
```

同步目标暴露 `delta()`（`file-api.ts:441`），返回「自上次游标以来变化的项」，游标跨次同步持久化。没有 delta 能力的后端退化为「远端列表 vs 本地列表」比对。

### 7. 重试是「带类型 + 退避」，不是全量 try/catch

`file-api.ts:102-122`：`tryAndRepeat()` 包裹每个请求，失败按 `1 + n*3` 秒退避，且**故意关掉底层 fetch 自带重试**避免叠加。
错误带 code（`fileNotFound`、`IsReadOnly`、`cannotSyncItem` 等），不同类型的失败走不同分支（冲突 / 跳过 / 重试），而不是一律失败。

### 8. 删除是墓碑，孤儿靠关联表回收

- 删除写 `deleted_time`，物理删除延后（保留期）。
- 资源是否还有引用，看 `note_resources`（`is_associated` / `last_seen_time`），据此清理孤儿 blob。

---

## 二、Joplin ↔ Trip 对照

| 维度 | Joplin | Trip 现在 | Trip 目标 |
| --- | --- | --- | --- |
| 记录 | `notes` | `trip_footprints` | 不变 |
| 资源元数据 | `resources` 表 | `image_url` / `image_urls`（塞在主表里） | `trip_footprint_assets` 表 |
| 关联 | `note_resources` | 数组字段 | 关联表（或 asset id 数组） |
| 本地文件命名 | `<resource_id>.<ext>` | `footprint-image-<随机>.<ext>` | `<asset_id>.<ext>` |
| 传输状态 | `resource_local_states.fetch_status`（不同步） | `sync_status` 在记录上（参与同步） | asset 级本地状态 |
| 变更检测 | `blob_updated_time` vs `sync_time` | 每次同步全量处理 pending | 同 Joplin |
| 本地无字节 | 拒绝上传 + cannot sync | （本次修复前会上传空 body） | 拒绝上传 + cannot_sync |
| 上传方式 | `RNFetchBlob.wrap(path)` 流式 | `fetch(file).arrayBuffer()` | `FileSystem.uploadAsync(path)` |
| 上传后校验 | 由 `Content-Length` + 服务端行为保证 | `storage.list` 校验 size（已加） | 保留 |
| 增量 | `delta()` + 游标 | 每次 `select *` 全量 | `updated_at > cursor` + 游标 |

---

## 三、实施方案（5 个阶段，逐阶段可回滚）

### 阶段 1：本地资产模型（纯客户端，不动服务器）

新增：

- `src/local/repositories/assetRepository.ts` —— 资产表（先用 AsyncStorage 独立键，规模变大再换 `expo-sqlite`）

  ```ts
  type Asset = {
    id: string;                 // uuid，也是对象 key 的一部分
    footprintId: string;
    position: number;
    fileName: string;           // 沙盒文件名 = <id>.<ext>
    size: number;
    mime: string;
    blobUpdatedTime: number;    // 内容变更时间
    remoteKey: string | null;   // 上传并校验成功后写入
    fetchStatus: 0 | 1 | 2 | 3; // idle / started / done / error（本地专用，绝不同步）
    fetchError: string | null;
    syncTime: number;           // 上次成功同步时间
    forceSync: boolean;
  };
  ```

- `src/features/daily/footprints/assetResolver.ts` —— 显示用：本地文件优先 → 远端 URL
- 迁移：读旧 `image_url(s)` → 生成 asset（本地文件 → `fetchStatus=DONE`；远端 URL → 解析出 `remoteKey`，标 `DONE`，size 未知）

改动：编辑器写路径（`FootprintEditorScreen.tsx`）、足迹列表与相册读路径（`FootprintScreen.tsx` / `FootprintAlbumScreen.tsx` / `imageCache.ts`）、repo 的增删改。

验收：本地新增/显示/编辑/删除全部走 asset；旧数据自动迁移不丢图；新增迁移 + 解析单测。
回滚：assets 是新增数据，旧字段保留可原路返回。

### 阶段 2：远端表 + 双写

新增 `trip_footprint_assets`（SQL 见 `docs/asset-sync-design.md`），带 RLS 与索引；同步时**双写**（asset 行 + 旧 `image_url(s)`）。
读取时 asset 行优先、旧字段兜底。

验收：新旧两条路径显示一致；服务端 SQL 可核对；单测覆盖双写一致性。
回滚：关闭双写。

### 阶段 3：blob 传输管线（核心，对应 Joplin 第 3/4/5 条）

```
picked → 落盘(<id>.<ext>，fetchStatus=DONE，blobUpdatedTime=now)
       → 判定是否上传：!remoteKey || syncTime < blobUpdatedTime || forceSync
       → 上传前：文件存在 && stat.size 与 asset.size 一致，否则 cannot_sync 并跳过
       → uploadAsync(PUT, path, { Content-Type, Content-Length, x-upsert })
       → 回读 size 校验 → 写 remoteKey + syncTime
       失败 → fetchError + 退避（1s/5s/30s/2m/10m），不影响其它记录
```

- 新增 `src/sync/assetBlobTransport.ts`：`uploadAssetBlob()`（`FileSystem.uploadAsync`）、`downloadAssetBlob()`
- `manualSync.ts` 从「记录级」改为「资产级队列 + 记录元数据合并」；记录同步不再携带 URL 替换
- 反向：远端有 asset 元数据、本地无 blob → `fetchStatus=IDLE`，进下载队列（详情页按需 + 可选全量）

验收：E2E 矩阵（断网 / 杀进程 / 大图 11 MB / 多图 / 重复同步 / 本地文件缺失 / 服务端 0 字节注入）。
回滚：切回旧的 `uploadFootprintImagesForSync`（保留一个同步周期）。

### 阶段 4：增量同步 + 对账

- 记录与资产都按 `updated_at > cursor` 拉取，游标持久化在本地元数据里。
- `scripts/audit-assets.mjs`：扫描「0 字节对象 / 孤儿对象 / 本地有远端无 / 远端有本地无」，输出报告。
- 服务端 GC：孤儿对象超保留期删除；墓碑记录超期清理。

验收：同一份数据连续两次同步，第二次请求量显著下降；对账报告为空。

### 阶段 5：体验层

- 图片级状态（上传中 / 待上传 / 失败重试）与「n 张待上传」入口
- 列表缩略图走服务端变换：`render/image/public/<bucket>/<key>?width=400&quality=70`
- 可选：断点续传（TUS，已验证可用）、仅 Wi-Fi 上传、按需下载策略

---

## 四、明确不照搬 Joplin 的部分

| Joplin 有 | 我们要不要 | 原因 |
| --- | --- | --- |
| E2EE（主密钥、加密 blob） | 不做 | 当前不是需求；数据模型留位（字段可空） |
| 多 sync target 抽象（Dropbox/OneDrive/WebDAV…） | 不做 | 我们只有一个目标：自建 Supabase |
| 分享 / 权限 / OCR | 不做 | 与本问题无关 |
| 冲突笔记副本 | 不做 | 记录级 LWW 足够；资产不可变，无冲突 |
| 资源「按需下载」全量实现 | 可简化 | 先做详情页按需，观察用量再决定 |

---

## 五、测试矩阵

| 层级 | 覆盖 |
| --- | --- |
| 单测 | 资产状态机迁移；blob 变更判定（改标题不重传）；cannot_sync 判定；迁移脚本；URL/本地解析优先级 |
| 契约 | 对真实 storage 跑 upload → list → size 校验（测试账号） |
| E2E（模拟器） | 加图 → 断网 → 恢复 → 上传 → 校验 → 缩略图显示；杀进程后继续；重复同步幂等；11 MB 大图 |
| 故障注入 | 上传返回 200 但 0 字节；中途断网；本地文件被删；磁盘满；权限拒绝 |
| 对账 | `audit-assets` 报告为空 |

---

## 六、风险与注意

1. **迁移一次性做完风险高**：阶段 1/2 都必须保持「旧字段仍可读」，否则老版本 App 会白屏。
2. **本地存储改造**：AsyncStorage 存 JSON 在几百张图后会变慢，阶段 1 若直接上 `expo-sqlite` 会一次性到位，但改动面更大——建议先确认图片量级（现在是几十张量级，可先用 AsyncStorage）。
3. **`react-native-blob-util` 是原生依赖**：需要 prebuild + 重装。若暂时不想加，`FileSystem.uploadAsync` 已能覆盖当前需求（50 MB 以内）。
4. **不要一边改一边维护两套上传路径**：阶段 3 完成后旧路径只保留一个同步周期用于回滚。
