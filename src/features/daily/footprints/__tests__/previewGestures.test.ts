import { describe, expect, it, jest } from '@jest/globals';

import { VERTICAL_PULL_CLOSE_THRESHOLD, createVerticalPullHandler } from '../previewGestures';

// scheduleOnRN 在测试环境里直接同步执行，方便断言「有没有触发关闭」
jest.mock('react-native-worklets', () => ({
  scheduleOnRN: (fn: (...args: unknown[]) => unknown, ...args: unknown[]) => fn(...args),
}));

describe('createVerticalPullHandler（下滑 = 直接退出预览）', () => {
  it('返回的回调必须是 worklet（否则 UI 线程会抛错并闪退）', () => {
    const handler = createVerticalPullHandler(() => undefined);
    expect(typeof (handler as unknown as { __workletHash?: number }).__workletHash).toBe('number');
  });

  it('下拉超过阈值松手就关闭', () => {
    const requestClose = jest.fn();
    createVerticalPullHandler(requestClose)({
      released: true,
      translateY: VERTICAL_PULL_CLOSE_THRESHOLD + 1,
    });
    expect(requestClose).toHaveBeenCalledTimes(1);
  });

  it('没到阈值不关闭', () => {
    const requestClose = jest.fn();
    createVerticalPullHandler(requestClose)({
      released: true,
      translateY: VERTICAL_PULL_CLOSE_THRESHOLD,
    });
    expect(requestClose).not.toHaveBeenCalled();
  });

  it('拖动过程中不关闭（松手才算）', () => {
    const requestClose = jest.fn();
    const handler = createVerticalPullHandler(requestClose);
    handler({ released: false, translateY: VERTICAL_PULL_CLOSE_THRESHOLD + 200 });
    handler({ released: false, translateY: 10 });
    expect(requestClose).not.toHaveBeenCalled();
  });

  it('回调里不再有黑板/跟手相关的副作用（只有关闭这一个动作）', () => {
    // 旧实现会通过第二个参数回调 onPullingChange 去淡出背板，那正是"闪"的来源
    expect(createVerticalPullHandler.length).toBe(1);
  });
});
