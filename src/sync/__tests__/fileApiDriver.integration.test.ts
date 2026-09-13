// 真实服务器集成测试（默认跳过）：TRIP_SYNC_INTEGRATION=1 npx jest src/sync/__tests__/fileApiDriver.integration.test.ts
// 验证：真实 trip_sync_items 表 + RLS + basicDelta 增量。
import { afterAll, describe, expect, it } from '@jest/globals';

import { getSupabaseClient, signInWithEmailPassword } from '../supabaseClient';
import { createSupabaseFileApi } from '../supabase/fileApiFactory';
import { SYNC_ITEMS_TABLE } from '../supabase/syncBackend';

const TEST_EMAIL = 'codex.trip.probe@example.com';
const TEST_PASSWORD = 'CodexTripProbe123!';
const ITEM_ID = 'aaaabbbbccccddddaaaabbbbccccdddd'; // 32 位 hex

const runIntegration = process.env.TRIP_SYNC_INTEGRATION === '1';
const describeIntegration = runIntegration ? describe : describe.skip;

function deltaOptions(context: unknown) {
  return {
    context,
    allItemIdsHandler: async () => [ITEM_ID],
    allItemMetadataHandler: async () => new Map(),
    wipeOutFailSafe: false,
  } as never;
}

async function currentUserId() {
  const supabase = getSupabaseClient();
  const { data } = await supabase.auth.getUser();
  return data.user?.id as string;
}

describeIntegration('SupabaseFileApiDriver（真实服务器）', () => {
  afterAll(async () => {
    const supabase = getSupabaseClient();
    const userId = await currentUserId();
    await supabase.from(SYNC_ITEMS_TABLE).delete().eq('path', `${userId}/${ITEM_ID}.md`);
  });

  it('写入/读取/增量/删除在真实表上生效，且 path 带用户前缀满足 RLS', async () => {
    await signInWithEmailPassword(TEST_EMAIL, TEST_PASSWORD);
    const userId = await currentUserId();
    const fileApi = await createSupabaseFileApi();

    const body = JSON.stringify({ location: '集成测试', visit_date: '2026-09-13' });
    await fileApi.put(`${ITEM_ID}.md`, body);

    // 直接查表确认落库（也验证 RLS 允许该用户读取自己的行）
    const supabase = getSupabaseClient();
    const { data: rows, error } = await supabase
      .from(SYNC_ITEMS_TABLE)
      .select('path,body,updated_at')
      .eq('path', `${userId}/${ITEM_ID}.md`);
    expect(error).toBeNull();
    expect(rows).toHaveLength(1);
    expect(rows?.[0].body).toBe(body);
    expect(Date.parse(String(rows?.[0].updated_at))).toBeGreaterThan(0);

    expect(await fileApi.get(`${ITEM_ID}.md`)).toBe(body);
    const stat = await fileApi.stat(`${ITEM_ID}.md`);
    expect(stat?.path).toBe(`${ITEM_ID}.md`);

    const first = await fileApi.delta('', deltaOptions(null));
    expect(first.items.some((item) => String(item.path) === `${ITEM_ID}.md`)).toBe(true);

    // 用同一个 context 再来一次：没有新变化就不重复返回（增量生效）
    const second = await fileApi.delta('', deltaOptions(first.context));
    expect(second.items.filter((item) => String(item.path) === `${ITEM_ID}.md`)).toHaveLength(0);

    await fileApi.delete(`${ITEM_ID}.md`);
    expect(await fileApi.stat(`${ITEM_ID}.md`)).toBeNull();
  }, 60000);
});
