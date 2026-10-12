import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Alert } from 'react-native';

import { listFootprintsLocal } from '@/src/local/repositories/footprintsRepository';
import { confirmNewFootprintDate, footprintsOnDate } from '../sameDayFootprints';

jest.mock('@/src/local/repositories/footprintsRepository', () => ({ listFootprintsLocal: jest.fn() }));
const list = jest.mocked(listFootprintsLocal);
const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
const record = (location: string, coordinate: string | null, visit_date = '2026-10-12') => ({
  id: location, location, coordinate, visit_date, tags: [],
  created_at: '2026-10-12T00:00:00Z', updated_at: '2026-10-12T00:00:00Z',
});

beforeEach(() => { jest.clearAllMocks(); });

describe('同日足迹二次确认', () => {
  it('按记录日期匹配，忽略其它日期和已删除足迹，不将日期转成 UTC', () => {
    const sameDay = record('故宫', '北京');
    const dated = record('颐和园', '北京', '2026-10-12T23:30:00-08:00');
    expect(footprintsOnDate([
      sameDay, dated, record('外滩', '上海', '2026-10-11'),
      { ...record('已删除', '广州'), deleted_at: '2026-10-12' },
    ], '2026-10-12')).toEqual([sameDay, dated]);
  });

  it('没有同日足迹时直接允许寄出', async () => {
    list.mockResolvedValue([record('外滩', '上海', '2026-10-11')]);
    expect(await confirmNewFootprintDate('2026-10-12')).toBe(true);
    expect(alert).not.toHaveBeenCalled();
  });

  it('显示同一天全部足迹的地点和城市，返回修改时不允许保存', async () => {
    list.mockResolvedValue([record('故宫', '北京'), record('外滩', '上海')]);
    const result = confirmNewFootprintDate('2026-10-12');
    await Promise.resolve();
    const [title, message, buttons] = alert.mock.calls[0];
    expect(title).toBe('这一天已有足迹');
    expect(message).toContain('已有 2 条足迹');
    expect(message).toContain('地点：故宫\n城市：北京');
    expect(message).toContain('地点：外滩\n城市：上海');
    buttons?.find((button) => button.text === '返回修改')?.onPress?.();
    expect(await result).toBe(false);
  });

  it('明确点击继续寄出后才允许创建，未填写的城市也显示出来', async () => {
    list.mockResolvedValue([record('故宫', null)]);
    const result = confirmNewFootprintDate('2026-10-12');
    await Promise.resolve();
    const [, message, buttons] = alert.mock.calls[0];
    expect(message).toContain('城市：未填写');
    buttons?.find((button) => button.text === '继续寄出')?.onPress?.();
    expect(await result).toBe(true);
  });

  it('关闭对话框视为取消，并且每次寄出重新读取最新记录', async () => {
    list.mockResolvedValueOnce([]).mockResolvedValueOnce([record('故宫', '北京')]);
    expect(await confirmNewFootprintDate('2026-10-12')).toBe(true);
    const result = confirmNewFootprintDate('2026-10-12');
    await Promise.resolve();
    alert.mock.calls[0][3]?.onDismiss?.();
    expect(await result).toBe(false);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('读取失败时不默认允许保存，由编辑页提示失败', async () => {
    list.mockRejectedValueOnce(new Error('读取失败'));
    await expect(confirmNewFootprintDate('2026-10-12')).rejects.toThrow('读取失败');
    expect(alert).not.toHaveBeenCalled();
  });
});
