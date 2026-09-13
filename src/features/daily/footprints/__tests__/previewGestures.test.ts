import { describe, expect, it, jest } from '@jest/globals';

import { VERTICAL_PULL_CLOSE_THRESHOLD, createVerticalPullHandler } from '../previewGestures';

// scheduleOnRN 在测试环境里直接同步执行，方便断言「有没有触发关闭」
jest.mock('react-native-worklets', () => ({
  scheduleOnRN: (fn: (...args: unknown[]) => unknown, ...args: unknown[]) => fn(...args),
}));

describe('createVerticalPullHandler', () => {
  it('返回的回调必须是 worklet（否则 UI 线程会抛错并闪退）', () => {
    const handler = createVerticalPullHandler(() => undefined);
    // babel 的 worklets 插件会给 worklet 函数打上 __workletHash / __initData
    expect(typeof (handler as unknown as { __workletHash?: number }).__workletHash).toBe('number');
  });

  it('下拉超过阈值并松手时关闭', () => {
    const onClose = jest.fn();
    createVerticalPullHandler(onClose)({ released: true, translateY: VERTICAL_PULL_CLOSE_THRESHOLD + 1 });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('距离不够或还没松手时不关闭', () => {
    const onClose = jest.fn();
    const handler = createVerticalPullHandler(onClose);

    handler({ released: true, translateY: VERTICAL_PULL_CLOSE_THRESHOLD });
    handler({ released: false, translateY: VERTICAL_PULL_CLOSE_THRESHOLD + 100 });
    handler({ released: true, translateY: 0 });

    expect(onClose).not.toHaveBeenCalled();
  });
});
