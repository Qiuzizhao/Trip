// 预览手势里跑在 UI 线程（worklet）上的回调。
//
// 单独放一个文件的原因：react-native-zoom-toolkit 的 Gallery 里，只有 onVerticalPull 是在
// useAnimatedReaction 的 worklet 里**直接调用**用户回调（onTap / onIndexChange / onSwipe 都在库里
// 包了 scheduleOnRN）。所以它必须是 worklet，传普通函数会在 UI 线程抛 non-worklet 并闪退。
//
// 设计（2026-09-15 极简版）：只做两件事——
//   下拉时照片由 Gallery 跟手往下走（库自带，不额外加效果）；
//   松手超过阈值就关闭预览，没到阈值由库把照片弹回去。
// 不加淡入淡出、不加飞出/滑入，避免任何多余动画被误看成闪烁或卡顿。
import { scheduleOnRN } from 'react-native-worklets';

/** 下拉超过这个距离并松手就关闭预览 */
export const VERTICAL_PULL_CLOSE_THRESHOLD = 80;

export type VerticalPullEvent = {
  translateY: number;
  released: boolean;
  velocityY?: number;
};

/**
 * 生成 Gallery 的 onVerticalPull 回调（必须 worklet，否则 UI 线程会闪退）。
 *
 * `onPullingChange` 用来告诉 JS 侧"现在正在往下拖"：往下拖的时候要把黑色背板去掉，
 * 只留照片跟着手指往下走；松手（回弹或关闭）再把背板恢复。
 */
export function createVerticalPullHandler(
  requestClose: () => void,
  onPullingChange: (pulling: boolean) => void,
) {
  return (event: VerticalPullEvent) => {
    'worklet';
    scheduleOnRN(onPullingChange, !event.released);
    if (!event.released) return;
    if (event.translateY > VERTICAL_PULL_CLOSE_THRESHOLD) {
      scheduleOnRN(requestClose);
    }
  };
}
