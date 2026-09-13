// 预览手势里跑在 UI 线程（worklet）上的回调。
//
// 为什么单独放一个文件：react-native-zoom-toolkit 的 Gallery 对这组回调的处理方式不一样，
// 只有 onVerticalPull 是在 useAnimatedReaction 的 worklet 里**直接调用**用户回调的
// （onTap / onIndexChange / onSwipe 等都在库里包了 scheduleOnRN）。所以它必须是 worklet，
// 传普通 JS 函数会在 UI 线程抛 "non-worklet function"，被 worklets 的 guard 重新抛出，
// 直接 std::terminate → 闪退（实测 SIGABRT）。
import { scheduleOnRN } from 'react-native-worklets';

/** 下拉超过这个距离并松手就关闭预览 */
export const VERTICAL_PULL_CLOSE_THRESHOLD = 80;

export type VerticalPullEvent = {
  translateY: number;
  released: boolean;
  velocityY?: number;
};

/**
 * 生成 Gallery 的 onVerticalPull 回调。
 * 必须是 worklet（在 UI 线程执行），关闭动作通过 scheduleOnRN 回到 JS 线程。
 */
export function createVerticalPullHandler(onClose: () => void) {
  return (event: VerticalPullEvent) => {
    'worklet';
    if (event.released && event.translateY > VERTICAL_PULL_CLOSE_THRESHOLD) {
      scheduleOnRN(onClose);
    }
  };
}
