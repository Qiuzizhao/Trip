import { describe, expect, it, jest } from '@jest/globals';

import { VERTICAL_PULL_CLOSE_THRESHOLD, createVerticalPullHandler } from '../previewGestures';

// scheduleOnRN 在测试环境里直接同步执行，方便断言「有没有触发关闭」
jest.mock('react-native-worklets', () => ({
  scheduleOnRN: (fn: (...args: unknown[]) => unknown, ...args: unknown[]) => fn(...args),
}));

// withTiming 同步调用回调并直接返回目标值，这样能断言"动画结束后才关闭"
jest.mock('react-native-reanimated', () => ({
  Easing: { cubic: () => 0, out: (fn: unknown) => fn, quad: () => 0 },
  withTiming: (toValue: number, _config?: unknown, callback?: (finished: boolean) => void) => {
    callback?.(true);
    return toValue;
  },
}));

function fakePull() {
  return { value: 0 } as unknown as Parameters<typeof createVerticalPullHandler>[1];
}

describe('createVerticalPullHandler', () => {
  it('返回的回调必须是 worklet（否则 UI 线程会抛错并闪退）', () => {
    const handler = createVerticalPullHandler(() => undefined, fakePull());
    // babel 的 worklets 插件会给 worklet 函数打上 __workletHash / __initData
    expect(typeof (handler as unknown as { __workletHash?: number }).__workletHash).toBe('number');
  });

  it('下拉超过阈值并松手时关闭（动画结束后才真正关闭）', () => {
    const onClose = jest.fn();
    const pull = fakePull();
    createVerticalPullHandler(onClose, pull)({
      released: true,
      translateY: VERTICAL_PULL_CLOSE_THRESHOLD + 1,
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    // 收起是"顺着松手方向继续走一段"，所以最终位移比松手时更大
    expect(pull.value).toBeGreaterThan(VERTICAL_PULL_CLOSE_THRESHOLD + 1);
  });

  it('拖动过程中把位移实时写进共享值（容器据此跟手变淡）', () => {
    const pull = fakePull();
    createVerticalPullHandler(() => undefined, pull)({ released: false, translateY: 42 });
    expect(pull.value).toBe(42);
  });

  it('距离不够或还没松手时不关闭，并且顺滑回位', () => {
    const onClose = jest.fn();
    const pull = fakePull();
    const handler = createVerticalPullHandler(onClose, pull);

    handler({ released: true, translateY: VERTICAL_PULL_CLOSE_THRESHOLD });
    handler({ released: false, translateY: VERTICAL_PULL_CLOSE_THRESHOLD + 100 });
    handler({ released: true, translateY: 0 });

    expect(onClose).not.toHaveBeenCalled();
    expect(pull.value).toBe(0);
  });
});
