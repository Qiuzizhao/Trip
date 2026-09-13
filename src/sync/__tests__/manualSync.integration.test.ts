// 真实服务器集成测试（默认跳过）：验证退役后的记录同步路径与线上表结构一致。
//   TRIP_SYNC_INTEGRATION=1 npx jest src/sync/__tests__/manualSync.integration.test.ts
import { afterAll, describe, expect, it } from '@jest/globals';

import AsyncStorage from '@react-native-async-storage/async-storage';

import { getSupabaseClient, signInWithEmailPassword } from '../supabaseClient';
import { runManualSync } from '../manualSync';

const TEST_EMAIL = 'codex.trip.probe@example.com';
const TEST_PASSWORD = 'CodexTripProbe123!';
const RECORD_ID = 'itest_record_retired_model';
const FOOTPRINTS_KEY = 'trip-footprints.footprints';

const runIntegration = process.env.TRIP_SYNC_INTEGRATION === '1';
const describeIntegration = runIntegration ? describe : describe.skip;

async function seedLocalRecord() {
  const record = {
    id: RECORD_ID,
    location: '集成测试-退役模型',
    coordinate: null,
    visit_date: '2026-09-13',
    notes: 'record sync without image columns',
    rating: 5,
    created_at: '2026-09-13T00:00:00.000Z',
    updated_at: '2026-09-13T00:00:00.000Z',
    deleted_at: null,
    sync_status: 'pending',
  };
  await AsyncStorage.setItem(FOOTPRINTS_KEY, JSON.stringify([record]));
}

describeIntegration('runManualSync（真实服务器，退役后模型）', () => {
  afterAll(async () => {
    const supabase = getSupabaseClient();
    await supabase.from('trip_footprints').delete().eq('id', RECORD_ID);
    await AsyncStorage.removeItem(FOOTPRINTS_KEY);
  });

  it('记录只同步元数据：写入成功、无需 image_url / image_urls 列', async () => {
    await signInWithEmailPassword(TEST_EMAIL, TEST_PASSWORD);
    await seedLocalRecord();

    const result = await runManualSync();
    expect(result.status).toBe('synced');

    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('trip_footprints')
      .select('id,location,notes,rating,visit_date,updated_at')
      .eq('id', RECORD_ID);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data?.[0]).toMatchObject({ id: RECORD_ID, location: '集成测试-退役模型', rating: 5 });
  }, 60000);
});
