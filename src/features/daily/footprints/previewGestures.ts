// 预览手势里跑在 UI 线程（worklet）上的回调。
//
// 为什么单独放一个文件：react-native-zoom-toolkit 的 Gallery 对这组回调的处理方式不一样，
// 只有 onVerticalPull 是在 useAnimatedReaction 的 worklet 里**直接调用**用户回调的
// （onTap / onIndexChange / onSwipe 等都在库里包了 scheduleOnRN）。所以它必须是 worklet，
// 传普通 JS 函数会在 UI 线程抛 "non-worklet function"，被 worklets 的 guard 重新抛出，
// 直接 std::terminate → 闪退（实测 SIGABRT）。
import { Easing, withTiming, type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

/** 下拉超过这个距离并松手就关闭预览 */
export const VERTICAL_PULL_CLOSE_THRESHOLD = 80;

/** 收起的动画时长 / 松手回位的时长（毫秒） */
const DISMISS_DURATION = 170;
const RESTORE_DURATION = 220;

export type VerticalPullEvent = {
  translateY: number;
  released: boolean;
  velocityY?: number;
};

/**
 * 生成 Gallery 的 onVerticalPull 回调。
 * 必须是 worklet（在 UI 线程执行），关闭动作通过 scheduleOnRN 回到 JS 线程。
 *
 * `pull` 是外部传入的共享值（下拉位移）：拖动过程中实时写入，
 * 预览容器据此同步变淡、轻微缩小，松手后继续把动画走完再关闭 ——
 * 而不是像以前那样"图片先弹回原位、再整体淡出"。
 */
export function createVerticalPullHandler(onClose: () => void, pull: SharedValue<number>) {
  return (event: VerticalPullEvent) => {
    'worklet';
    if (!event.released) {
      pull.value = event.translateY;
      return;
    }

    if (event.translateY > VERTICAL_PULL_CLOSE_THRESHOLD) {
      // 收：顺着松手方向继续走一段，动画结束后再真正关闭
      pull.value = withTiming(
        event.translateY + 120,
        { duration: DISMISS_DURATION, easing: Easing.out(Easing.quad) },
        (finished) => {
          if (finished) scheduleOnRN(onClose);
        },
      );
      return;
    }

    // 没到阈值：顺滑回到原位
    pull.value = withTiming(0, { duration: RESTORE_DURATION, easing: Easing.out(Easing.cubic) });
  };
}
