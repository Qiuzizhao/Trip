// 对账 / GC 脚本共用的 Storage + PostgREST 访问层
export const BUCKET = 'trip-footprint-images';

export function createStore() {
  const url = (process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !serviceKey) {
    console.error('缺少 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY');
    process.exit(2);
  }

  const authHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };

  async function rest(pathQuery, init = {}) {
    const response = await fetch(`${url}/rest/v1/${pathQuery}`, {
      ...init,
      headers: { ...authHeaders, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
    if (!response.ok) throw new Error(`PostgREST ${response.status}: ${await response.text()}`);
    return response.status === 204 ? null : response.json();
  }

  async function listFolder(prefix) {
    const response = await fetch(`${url}/storage/v1/object/list/${BUCKET}`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix, limit: 1000, offset: 0 }),
    });
    if (!response.ok) throw new Error(`Storage list ${response.status}: ${await response.text()}`);
    return response.json();
  }

  async function listAllObjects(prefix = '') {
    const entries = await listFolder(prefix);
    const objects = [];
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.id === null || entry.metadata === null) {
        objects.push(...await listAllObjects(path));
      } else {
        objects.push({ path, size: Number(entry.metadata?.size ?? 0), mime: entry.metadata?.mimetype ?? null });
      }
    }
    return objects;
  }

  async function deleteObject(path) {
    const response = await fetch(`${url}/storage/v1/object/${BUCKET}/${path}`, { method: 'DELETE', headers: authHeaders });
    if (!response.ok && response.status !== 404) {
      throw new Error(`删除对象失败 ${path}: ${response.status} ${await response.text()}`);
    }
  }

  // 引用关系现在只来自资产元数据项（image_url / image_urls 已于 2026-09-13 退役）
  function referencedKeysFromItems(items) {
    const referenced = new Set();
    const metadataAssets = [];
    for (const item of items) {
      if (!item.body || item.deleted_at) continue;
      try {
        const parsed = JSON.parse(item.body);
        if (parsed?.remoteKey) {
          referenced.add(parsed.remoteKey);
          metadataAssets.push({ path: item.path, ...parsed });
        }
      } catch {
        // 非资产元数据项
      }
    }
    return { referenced, metadataAssets };
  }

  return { deleteObject, listAllObjects, referencedKeysFromItems, rest };
}
