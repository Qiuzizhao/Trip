// Supabase 版同步驱动：给 vendored 的 FileApi 提供 stat/list/get/put/delete/delta。
// 参考上游 file-api-driver-joplinServer.ts 的方法集与返回形状。
import { basicDelta, type DeltaOptions, type ItemStat, type PaginatedList } from '@/src/vendor/joplin/file-api';
import { contentTypeForObjectKey } from '../mimeTypes';
import type { SyncBackend, SyncItemRow } from './syncBackend';

export const SYNC_ITEM_TYPE_RECORD = 1;
export const SYNC_ITEM_TYPE_ASSET = 2;
export const SYNC_ITEM_TYPE_RESOURCE = 9;

type ExecOptions = {
  path?: string;
  source?: string;
  target?: string;
  contentType?: string;
};

export class SupabaseFileApiDriver {
  public constructor(
    private backend_: SyncBackend,
    private userId_: string,
  ) {}

  // 数据库里的 path 一律带 <user_id>/ 前缀，便于 RLS；对 FileApi 一侧保持 Joplin 形状
  private toDbPath(path: string) {
    return path ? `${this.userId_}/${path}` : `${this.userId_}/`;
  }

  private fromDbPath(dbPath: string) {
    const prefix = `${this.userId_}/`;
    return dbPath.startsWith(prefix) ? dbPath.slice(prefix.length) : dbPath;
  }

  private toStat(row: SyncItemRow): ItemStat {
    return {
      path: this.fromDbPath(row.path),
      updated_time: row.updatedAt,
      isDir: false,
    };
  }

  private objectKeyForPath(path: string) {
    // 'resources/<hex>' -> '<user>/assets/<hex>'（blob 存 Storage，元数据存表）
    const name = this.fromDbPath(path).split('/').pop() || 'item';
    return `${this.userId_}/assets/${name}`;
  }

  public async initialize() {
    // no-op：表结构由 docs/supabase/trip-sync-items.sql 建立
  }

  public get supportsMultiPut() { return false; }
  public get supportsMultiDelete() { return false; }
  public get supportsAccurateTimestamp() { return false; }
  public get supportsLocks() { return false; }

  public requestRepeatCount() {
    return 3;
  }

  public async stat(path: string) {
    const row = await this.backend_.getItem(this.toDbPath(path));
    if (!row || row.deletedAt) return null;
    return this.toStat(row);
  }

  // DRIVER MUST RETURN PATHS RELATIVE TO `path`
  public async list(path: string, _options: unknown = null): Promise<PaginatedList> {
    const rows = await this.backend_.listItems(this.toDbPath(path));
    return {
      items: rows
        .filter((row) => !row.deletedAt)
        .map((row) => ({ ...this.toStat(row), id: row.itemId })),
      hasMore: false,
      context: null,
    };
  }

  public async get(path: string, options: ExecOptions | null = null) {
    // 'resources/<id>' 对应 Storage 里的 blob，不查表
    if (this.fromDbPath(path).startsWith('resources/') && options?.target === 'file') {
      if (!options.path) throw new Error('get: target=file 需要 options.path');
      await this.backend_.downloadBlob(this.objectKeyForPath(path), options.path);
      return null;
    }

    const row = await this.backend_.getItem(this.toDbPath(path));
    if (!row || row.deletedAt) return null;

    return row.body;
  }

  public async put(path: string, content: string | Buffer | null, options: ExecOptions | null = null) {
    const relative = this.fromDbPath(path);
    const name = relative.split('/').pop() || relative;
    const isResource = relative.startsWith('resources/');

    if (options?.source === 'file') {
      if (!options.path) throw new Error('put: source=file 需要 options.path');
      const objectKey = this.objectKeyForPath(path);
      const contentType = options.contentType || contentTypeForObjectKey(objectKey);
      const storedSize = await this.backend_.uploadBlob(objectKey, options.path, contentType);
      if (!storedSize) throw new Error(`上传后对象为空：${objectKey}`);
      return null;
    }

    await this.backend_.upsertItem({
      path: this.toDbPath(path),
      itemId: name.replace(/\.[^.]+$/, ''),
      type: isResource ? SYNC_ITEM_TYPE_RESOURCE : SYNC_ITEM_TYPE_ASSET,
      body: typeof content === 'string' ? content : null,
      jopUpdatedTime: Date.now(),
      deletedAt: null,
    });
    return null;
  }

  public async delete(path: string) {
    await this.backend_.tombstoneItem(this.toDbPath(path));
  }

  public async mkdir(_path: string) {
    // no-op：所有项都在同一平面命名空间里
  }

  public async format() {
    throw new Error('Not supported');
  }

  public async clearRoot() {
    throw new Error('Not supported');
  }

  public async delta(path: string, options: DeltaOptions): Promise<PaginatedList> {
    const getStatFn = async (dirPath: string) => {
      const rows = await this.backend_.listItems(this.toDbPath(dirPath));
      const prefixLength = this.toDbPath(dirPath).length;
      return rows
        .filter((row) => !row.deletedAt)
        .map((row) => ({
          path: row.path.slice(prefixLength),
          isDir: false,
          updated_time: row.updatedAt,
        }));
    };
    return basicDelta(path, getStatFn, options);
  }
}
