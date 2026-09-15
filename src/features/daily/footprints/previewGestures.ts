// 预览手势里跑在 UI 线程（worklet）上的回调。
//
// 单独放一个文件的原因：react-native-zoom-toolkit 的 Gallery 里，只有 onVerticalPull 是在
// useAnimatedReaction 的 worklet 里**直接调用**用户回调（onTap / onIndexChange / onSwipe 都在库里
// 包了 scheduleOnRN）。所以它必须是 worklet，传普通函数会在 UI 线程抛 non-worklet 并闪退。
//
// 设计（2026-09-15 二版）：**下滑 = 点空白 = 直接退出预览**。
//   下拉过程中照片不动、黑板不变（库里已经去掉了跟手位移），
//   松手超过阈值就直接关闭预览；没到阈值什么都不发生。
// 没有任何跟手/回弹/淡入淡出动画，也就不存在"闪一下"这种观感问题。
import { scheduleOnRN } from 'react-native-worklets';

/** 下拉超过这个距离并松手就关闭预览 */
export const VERTICAL_PULL_CLOSE_THRESHOLD = 50;

export type VerticalPullEvent = {
  translateY: number;
  released: boolean;
  velocityY?: number;
};

/** 生成 Gallery 的 onVerticalPull 回调（必须 worklet，否则 UI 线程会闪退） */
export function createVerticalPullHandler(requestClose: () => void) {
  return (event: VerticalPullEvent) => {
    'worklet';
    if (!event.released) return;
    if (event.translateY > VERTICAL_PULL_CLOSE_THRESHOLD) {
      scheduleOnRN(requestClose);
    }
  };
}
