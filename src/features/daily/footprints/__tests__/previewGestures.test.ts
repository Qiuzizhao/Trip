import { describe, expect, it, jest } from '@jest/globals';

import { VERTICAL_PULL_CLOSE_THRESHOLD, createVerticalPullHandler } from '../previewGestures';

// scheduleOnRN 在测试环境里直接同步执行，方便断言「有没有触发关闭」
jest.mock('react-native-worklets', () => ({
  scheduleOnRN: (fn: (...args: unknown[]) => unknown, ...args: unknown[]) => fn(...args),
}));

describe('createVerticalPullHandler（极简版）', () => {
  it('返回的回调必须是 worklet（否则 UI 线程会抛错并闪退）', () => {
    const handler = createVerticalPullHandler(() => undefined, () => undefined);
    expect(typeof (handler as unknown as { __workletHash?: number }).__workletHash).toBe('number');
  });

  it('下拉超过阈值松手就关闭', () => {
    const requestClose = jest.fn();
    createVerticalPullHandler(requestClose, () => undefined)({
      released: true,
      translateY: VERTICAL_PULL_CLOSE_THRESHOLD + 1,
    });
    expect(requestClose).toHaveBeenCalledTimes(1);
  });

  it('下拉过程中会通知"正在下拉"（用来去掉黑底）', () => {
    const onPullingChange = jest.fn();
    const handler = createVerticalPullHandler(() => undefined, onPullingChange);
    handler({ released: false, translateY: 40 });
    expect(onPullingChange).toHaveBeenLastCalledWith(true);
    handler({ released: true, translateY: 40 });
    expect(onPullingChange).toHaveBeenLastCalledWith(false);
  });

  it('没到阈值、或者还在拖动时不关闭', () => {
    const requestClose = jest.fn();
    const handler = createVerticalPullHandler(requestClose, () => undefined);
    handler({ released: true, translateY: VERTICAL_PULL_CLOSE_THRESHOLD });
    handler({ released: false, translateY: VERTICAL_PULL_CLOSE_THRESHOLD + 200 });
    expect(requestClose).not.toHaveBeenCalled();
  });

  it('关闭路径不恢复黑底（否则 Modal 卸载前会闪一帧纯黑）', () => {
    const requestClose = jest.fn();
    const onPullingChange = jest.fn();
    const handler = createVerticalPullHandler(requestClose, onPullingChange);
    handler({ released: false, translateY: 120 });
    onPullingChange.mockClear();
    handler({ released: true, translateY: VERTICAL_PULL_CLOSE_THRESHOLD + 40 });
    expect(requestClose).toHaveBeenCalledTimes(1);
    // 松手关闭这条路径上不允许再动背板
    expect(onPullingChange).not.toHaveBeenCalled();
  });
});
