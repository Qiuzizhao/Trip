# 图片附件同步：目标架构（成熟方案）

> 适用：Trip / WorkLog 这一族 Expo + 自建 Supabase 的 App。
> 目标：把「图片上传 + 离线可用 + 跨设备同步」做成一个可验证、可恢复、不会静默丢数据的管线。

## 0. 核心结论

1. **资产（字节）与记录（元数据）分离**：资产不可变、按唯一 key 寻址；记录可变、可合并，且不存展示 URL。
2. **本地文件是真相来源**：同步永远不覆盖本地引用；远端只在“已校验”后才被记录引用。
3. **上传走原生通道**：`FileSystem.uploadAsync`（或 `File` + `expo/fetch`），禁止 `Blob` 请求体。
4. **每个 key 只对应一份内容**：key 用上传时生成的 UUID（或内容 hash），彻底消除缓存失效问题。
5. **同步 = 队列 + 状态机 + 校验 + 重试**，不是“一个大函数按顺序做完所有事”。
6. **服务端可观测**：0 字节对象、孤儿对象、上传成功率都有定时对账。

---

## 1. 现状与结构性缺陷

| 现象 | 根因 | 现有补丁 |
| --- | --- | --- |
| 同步后图片全变灰 | `fetch(file://).blob()` 当请求体，RN 序列化成空 part → 对象 0 字节 | 已改为 `ArrayBuffer` + 上传后校验 |
| 图片“修好了还是灰” | 同 key 复写内容 + `max-age=31536000`，CDN/客户端缓存命中旧空图 | 修复时改 URL 加 `?v=` |
| 上传失败 = 丢图 | 记录里的本地 URI 被远端 URL 覆盖，本地引用丢失 | 失败时保留本地 URI + 标记 failed |
| 历史数据无法自愈 | 记录里没有“本地文件 ↔ 远端对象”的稳定映射 | 用对象名里的路径 hash 反查本地文件 |
| WorkLog 52/52 对象全 0 字节 | 同一套 `.blob()` 写法被复制到另一个 App | 未修 |

结构性问题（不是靠补丁能消化掉的）：

- `image_url` 一个字段同时承载 `file://` 与 `https://` 两种含义，所有读取方都要分支判断；
- 同步以“整条记录”为粒度，图片只能跟着记录一起成功或失败；
- 记录状态只有一个 `sync_status`，无法表达“3 张图里 1 张待上传”；
- 没有上传队列，App 被杀/断网后没有恢复点；
- 对象 key 用本地路径 hash，内容变了 key 不变，缓存语义被破坏。

---

## 2. 参考实现（现行开源项目）

| 项目 | 它怎么解决 | 借鉴什么 |
| --- | --- | --- |
| **CouchDB / PouchDB attachments** | 文档里只放 stub（`digest` / `length` / `revpos`），二进制单独传输；revision 保证“同 key 换内容”不发生 | 最贴合我们的模型：**记录引用 stub + 不可变对象 + 版本化** |
| **Immich** | 移动端本地 asset 表（checksum + upload 状态机）、上传队列、服务端校验 checksum、去重、断点续传；本地 id 与远端 id 分离 | 状态机字段设计、队列与后台重试、服务端校验 |
| **PowerSync** | 本地优先同步引擎，内置 attachments API：队列 + 校验 + 本地缓存 + 后台重试 | 附件队列的工程化细节（并发、退避、恢复） |
| **RxDB / WatermelonDB** | 把附件当一等公民；push/pull 分离的复制协议 | 协议形状：元数据合并与字节传输互不耦合 |
| **tus（tus-js-client）/ Uppy** | 可续传上传协议（Resumable Upload），断网/杀进程后可续 | 50 MB 以内图片可选；你的 storage 已支持 |
| **Syncthing / rclone** | checksum 先行、定期 `verify` 对账 | 定时对账任务，而不是只在写入时校验一次 |
| **MinIO / S3 预签名 PUT 模式** | 两阶段：申请票据 → 上传 → 提交记录，避免孤儿对象 | 事务边界：先落对象，再落引用 |
| **Nextcloud 文件缓存** | 每个文件带 etag + checksum，缓存按内容失效 | 缓存 key 与内容绑定 |

反面教材：MongoDB Atlas Device Sync 已于 2025-09 停止服务。同步逻辑不要绑死在某家会消失的托管服务上，尽量落在你自己的 Postgres + 对象存储上。

---

## 3. 目标架构

### 3.1 三层职责

- **资产层（bytes）**：不可变、唯一 key、只增不改、可校验。
- **记录层（metadata）**：可变、可合并（LWW）、只引用资产 key，不存展示 URL。
- **传输层（sync）**：队列 + 状态机 + 校验 + 退避重试 + 对账。

### 3.2 数据模型

本地（建议 `expo-sqlite`；迁移期可先用现有 AsyncStorage + 独立队列键）：

```sql
assets(
  id            TEXT PRIMARY KEY,   -- 本地 uuid，也是对象 key 的一部分
  record_id     TEXT NOT NULL,
  position      INTEGER NOT NULL,
  local_name    TEXT NOT NULL,      -- 沙盒文件名（真相来源，永不被同步覆盖）
  local_size    INTEGER NOT NULL,
  content_hash  TEXT,               -- 可选；用于去重与端到端校验
  remote_key    TEXT,               -- 上传成功并校验后写入，之后不再变
  status        TEXT NOT NULL,      -- local|queued|uploading|uploaded|failed|missing
  attempts      INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error    TEXT
)

upload_queue(
  asset_id   TEXT PRIMARY KEY REFERENCES assets(id),
  enqueued_at TEXT NOT NULL,
  priority   INTEGER NOT NULL DEFAULT 0
)
```

远端（Postgres）：

```sql
create table if not exists trip_footprint_assets (
  id            uuid primary key default gen_random_uuid(),
  footprint_id  text not null references trip_footprints(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  object_key    text not null,
  size_bytes    bigint not null,
  content_hash  text,
  mime_type     text,
  position      int not null default 0,
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create index if not exists trip_footprint_assets_footprint_idx
  on trip_footprint_assets (footprint_id, position);
```

对象 key 规范（二选一）：

- **推荐**：`<user_id>/<footprint_id>/<asset_uuid>.<ext>` —— 生成简单、天然不可变、重试幂等。
- 可选：内容寻址 `<sha256[0:2]>/<sha256>.<ext>` —— 额外获得去重，但 RN 里对 7 MB 文件做流式 hash 成本较高。

兼容：旧 `image_url` / `image_urls` 保留**只读**兼容（读取时新结构优先、旧字段兜底），写路径不再使用。

### 3.3 上传管线（状态机）

```
picked ──► local ──► queued ──► uploading ──► verify ──► uploaded
                       ▲             │                    (写 remote_key)
                       └───── failed ◄┘  退避重试，保留本地引用
```

- 落盘即入队（`local`），UI 立刻用本地图渲染，不等网络；
- 上传用 `FileSystem.uploadAsync(url, fileUri, { httpMethod: 'POST', uploadType: BINARY_CONTENT, headers })`，或 `File` + `expo/fetch`；
- **校验**：回读对象 size（`storage.list` 元数据）或比对 ETag/size，一致才写 `remote_key`；
- 失败 → `failed` + 指数退避（1s/5s/30s/2m/10m），网络恢复、App 启动、用户手动同步时唤醒队列；
- 并发 2~3；同一 `asset_uuid` + `upsert` 保证重试幂等；
- 队列持久化，进程被杀后从上次状态继续。

### 3.4 展示与缓存

- 显示时派生 URL，而不是存储 URL：
  1. 本地文件存在 → `file://...`（离线、即时）
  2. 否则 → 远端对象 URL
- 缩略图用服务端变换（你的 storage 已开启 `ENABLE_IMAGE_TRANSFORMATION` + imgproxy）：列表用 `.../render/image/public/<bucket>/<key>?width=400&quality=70`，详情页再取原图。
- `cacheKey = remote_key`（不可变），配合 `Cache-Control: immutable` → 缓存永远不会脏。
- 预取只覆盖可见项 + 缩略图，避免一次性拉几十张大图。

### 3.5 删除与 GC

- 删除记录 = 写墓碑；不级联删对象。
- 服务端定时作业：`trip_footprint_assets` 中引用计数为 0 且超过 N 天的对象删除。
- 本地文件在上传成功后**不立即删除**：保留到“远端校验通过 + 磁盘压力触发清理”或用户主动清理。

### 3.6 冲突模型

- 元数据：LWW（沿用现有 `mergeSyncRecords`，按 `updated_at`）。
- 资产：**没有冲突**——不可变、按 id 追加、删除用墓碑。这也是不要把图片塞进 CRDT 的原因。

---

## 4. RN 层硬规则（本 App 家族的踩坑规约）

1. 不要把 `Blob` 当请求体传出去；可用形态只有 `FileSystem.uploadAsync`、`File`/`expo/fetch`、`FormData({uri,name,type})`。
2. 大于 ~10 MB 的文件不要进 JS 内存（`arrayBuffer()` 只用于小图兜底）。
3. 上传后必须校验产物（size/hash），不能把 HTTP 200 当作成功。
4. 同一个 key 不得写入不同内容（要换内容就换 key）。
5. 显示永远优先本地文件。
6. 网络失败是**状态**，不是异常；任何失败都不允许改写记录的本地引用。

---

## 5. 迁移方案（分 4 阶段，每阶段可回滚）

| 阶段 | 内容 | 判定指标 | 回滚点 |
| --- | --- | --- | --- |
| **0（已完成）** | 二进制上传 + 上传后校验 + 失败保留本地 + 历史对象修复 | 新上传 0 字节率 = 0 | 保留旧字段即可回退 |
| **1** | 建 `assets` 表（本地 + 远端），上传成功后**双写** `remote_key` 与旧 URL 字段；读取新结构优先 | 双写一致率 100% | 关闭双写 |
| **2** | 切换显示/上传到新管线（队列 + 状态机 + 缩略图 + 图片级进度 UI） | 上传成功率、队列积压、平均重试次数 | 切回旧读取路径 |
| **3** | 回填历史资产、清理 `image_url(s)` 旧字段、服务端 GC 0 字节与孤儿对象 | 0 字节对象数 = 0 | 保留字段快照 |

历史数据回填可直接复用现有逻辑：对象名 `<n>-<本地路径 hash>.<ext>` 能反查本地文件，用它生成 asset 行并把 `remote_key` 指向同一对象。

---

## 6. 测试与验收

- **单元**：状态机迁移、key 生成、校验失败、退避计算、队列去重。
- **契约**：对真实 storage 跑 `upload → list → size 校验`（测试账号，CI 可选执行）。
- **E2E（模拟器/真机）**：选图 → 断网 → 恢复 → 上传 → 校验 → 缩略图显示；杀进程后继续；重复同步幂等。
- **故障注入**：上传返回 200 但 0 字节（已覆盖）、中途断网、磁盘写满、相册权限被拒。
- **对账工具**：`npm run audit:assets` 扫描远端 `size = 0` 或未被任何记录引用的对象，输出报告（本次定位就是靠它）。

---

## 7. 可观测性

- 客户端：上传事件（asset_id / size / 耗时 / 重试次数 / 失败原因），失败按 error type 聚合。
- 服务端定时检查：0 字节对象数、孤儿对象数、`trip_footprint_assets` 与 storage 的一致性。
- 三个核心指标：**上传成功率**、**0 字节对象数（应为 0）**、**待上传队列长度**。

---

## 8. 分期与工作量

| 项 | 估算 |
| --- | --- |
| 阶段 1（双写 + 表结构 + 迁移脚本） | 0.5~1 天 |
| 阶段 2（队列 + 状态机 + 缩略图 + 图片级 UI） | 1~1.5 天 |
| 阶段 3（回填 + 清理 + 服务端 GC/对账） | 0.5~1 天 |
| 可选：TUS 断点续传 | 0.5 天 |
| WorkLog 同款改造 | 1 天（含历史资产核对） |

---

## 9. 明确不做（避免过度设计）

- 不引入 CRDT——图片是不可变字节，不存在合并语义。
- 不引入 PowerSync / WatermelonDB 这类完整同步框架——当前规模下收益小于迁移成本，只借鉴其协议形状。
- 不自建上传后端服务（TUS 之外的场景暂时用不到）。
- 不把同步绑到会停服的托管同步服务。

---

## 附：本机能力实测

| 能力 | 结果 |
| --- | --- |
| TUS 可续传 | `OPTIONS /storage/v1/upload/resumable` → 204，`tus-resumable: 1.0.0`，`tus-max-size: 52428800` |
| 图片变换（缩略图） | storage `ENABLE_IMAGE_TRANSFORMATION=true`，`IMGPROXY_URL=http://imgproxy:5001`，imgproxy 容器运行中 |
| 原生二进制上传 | `expo-file-system/legacy` 的 `uploadAsync(url, fileUri, …)` 可用；实测 991,481 B 完整落盘 |
| 新文件 API | `File.bytes()` / `File.arrayBuffer()` / `File.base64()` 可用（原生读取，不过桥） |
| `expo/fetch` | 存在，`FormData` 由原生转 `Uint8Array` |
| supabase-js storage TUS | `@supabase/storage-js@2.108.2` 无内置 TUS，需 `tus-js-client`（可选阶段） |
