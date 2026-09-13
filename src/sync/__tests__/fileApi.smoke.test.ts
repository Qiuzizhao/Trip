import { describe, expect, it } from '@jest/globals';

import { createMemoryFileApi } from '../supabase/fileApiFactory';

// 32 位十六进制：符合 vendored isSystemPath 的规则
const ITEM_ID = '1b175bb38bba47baac22b0b47f778113';

function deltaOptions(context: unknown) {
  return {
    context,
    allItemIdsHandler: async () => [ITEM_ID],
    allItemMetadataHandler: async () => new Map(),
    wipeOutFailSafe: false,
  } as never;
}

describe('vendored FileApi（memory driver）', () => {
  it('put / stat / get / list / delete 闭环', async () => {
    const api = createMemoryFileApi();

    await api.put(`${ITEM_ID}.md`, JSON.stringify({ hello: 'world' }));

    const stat = await api.stat(`${ITEM_ID}.md`);
    expect(stat.path).toContain(ITEM_ID);

    const body = await api.get(`${ITEM_ID}.md`);
    expect(JSON.parse(String(body))).toEqual({ hello: 'world' });

    const list = await api.list();
    expect(list.items.length).toBe(1);

    await api.delete(`${ITEM_ID}.md`);
    // 上游 memory driver 对不存在的项返回 null（不是抛错）
    expect(await api.get(`${ITEM_ID}.md`)).toBeNull();
  });

  it('basicDelta：第一次能发现新增项，用返回的 context 再来一次则为空', async () => {
    const api = createMemoryFileApi();
    await api.put(`${ITEM_ID}.md`, 'v1');

    const first = await api.delta('', deltaOptions(null));
    expect(first.items.length).toBeGreaterThan(0);

    const second = await api.delta('', deltaOptions(first.context));
    expect(second.items.length).toBe(0);
  });

  it('basicDelta：远端删除会被识别为 isDeleted 项', async () => {
    const api = createMemoryFileApi();
    await api.put(`${ITEM_ID}.md`, 'v1');

    const first = await api.delta('', deltaOptions(null));
    await api.delete(`${ITEM_ID}.md`);

    const afterDelete = await api.delta('', deltaOptions(first.context));
    expect(afterDelete.items.some((item: { isDeleted?: boolean }) => item.isDeleted)).toBe(true);
  });
});
