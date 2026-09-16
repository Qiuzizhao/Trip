// 同步进度上报测试：「同步中」弹窗的进度必须来自真实阶段，且不能回退。
import { describe, expect, it } from '@jest/globals';

import {
  SYNC_PHASE_ORDER,
  SYNC_PROGRESS_COMPLETE,
  countProgress,
  phasePercent,
  phaseStepState,
  ratioProgress,
} from '../syncProgress';

describe('syncProgress', () => {
  it('按阶段区间换算整体百分比', () => {
    expect(countProgress('records', 1, 2, ' 条').percent).toBe(13); // 0-25 的一半
    expect(phasePercent('records', 1)).toBe(25);
    expect(phasePercent('assets', 1)).toBe(70);
    expect(phasePercent('repair', 1)).toBe(85);
    expect(phasePercent('merge', 1)).toBe(100);
    expect(ratioProgress('assets', 0.5).percent).toBe(48); // 25 + 45*0.5
  });

  it('生成带计数与单位的说明文案', () => {
    expect(countProgress('assets', 3, 12, ' 张').detail).toBe('同步照片资产 3/12 张');
    expect(countProgress('assets', 0, 0).detail).toBe('同步照片资产');
    // 资产阶段内部再分段时用 stepText 显示上传/下载各自计数
    expect(ratioProgress('assets', 0.3, '同步照片资产 · 上传 3/12 张', '3/12').stepText).toBe('3/12');
  });

  it('完成数不会超过总数', () => {
    const progress = countProgress('repair', 99, 10, ' 张');
    expect(progress.done).toBe(10);
    expect(progress.percent).toBe(85);
  });

  it('四个阶段连起来单调递增，最后正好 100%', () => {
    let previous = -1;
    for (const phase of SYNC_PHASE_ORDER) {
      for (const ratio of [0, 0.25, 0.5, 0.75, 1]) {
        const percent = phasePercent(phase, ratio);
        expect(percent).toBeGreaterThanOrEqual(previous);
        previous = percent;
      }
    }
    expect(previous).toBe(100);
    expect(SYNC_PROGRESS_COMPLETE.percent).toBe(100);
  });

  it('步骤状态跟着当前阶段走', () => {
    expect(phaseStepState('records', 'assets', false)).toBe('done');
    expect(phaseStepState('assets', 'assets', false)).toBe('active');
    expect(phaseStepState('repair', 'assets', false)).toBe('pending');
    expect(phaseStepState('merge', null, false)).toBe('pending');
    expect(phaseStepState('repair', 'assets', true)).toBe('done');
  });
});
