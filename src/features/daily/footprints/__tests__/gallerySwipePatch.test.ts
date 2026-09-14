import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 保证 `patches/react-native-zoom-toolkit+5.1.1.patch` 真的应用上了，并且行为符合预期。
 *
 * 原版只在「手势最后 175ms 内速度 ≥500px/s」时才算翻页（必须快速甩动），
 * 所以慢慢拖、或从左半边起手加不起速时都翻不了页 —— 手感发涩。
 * 补丁额外接受「拖过 itemSize 的 25%」，慢速拖动也能翻页。
 *
 * 直接读 node_modules 里的实现来测（包的 exports 不允许深层 import）：
 * 去掉 `export` 前缀后用 Function 求值，拿到的是真正会跑在 App 里的那段代码。
 */
function loadSwipeDirection() {
  const file = path.join(
    process.cwd(),
    'node_modules/react-native-zoom-toolkit/lib/module/commons/utils/getSwipeDirection.js',
  );
  const code = fs.readFileSync(file, 'utf8').replace(/^export\s+/gm, '');
  // eslint-disable-next-line no-new-func
  // 注意结尾要换行：文件末尾是 sourceMappingURL 注释，直接拼会被注释掉
  return new Function(`${code}\n; return getSwipeDirection;`)() as (
    event: { absoluteX: number; absoluteY: number; velocityX: number; velocityY: number },
    options: Record<string, unknown>,
  ) => string | undefined;
}

describe('Gallery 滑动判定（补丁后）', () => {
  const getSwipeDirection = loadSwipeDirection();
  const base = {
    boundaries: { x: 0, y: 0 },
    itemSize: 400,
    translate: { x: 0, y: 0 },
    time: performance.now(),
  };

  it('慢速拖过 25% 宽度也算翻页（原版这里是 undefined）', () => {
    expect(getSwipeDirection(
      { absoluteX: 100, absoluteY: 300, velocityX: -50, velocityY: 0 },
      { ...base, position: { x: 300, y: 300 } },
    )).toBe('left');
  });

  it('只拖一点点不会误翻页', () => {
    expect(getSwipeDirection(
      { absoluteX: 280, absoluteY: 300, velocityX: -50, velocityY: 0 },
      { ...base, position: { x: 300, y: 300 } },
    )).toBeUndefined();
  });

  it('原来的快速甩动行为保持不变', () => {
    expect(getSwipeDirection(
      { absoluteX: 250, absoluteY: 300, velocityX: -900, velocityY: 0 },
      { ...base, position: { x: 300, y: 300 } },
    )).toBe('left');
  });
});

/**
 * 下拉 / 方向锁这几个补丁跑在 UI 线程的 worklet 里，单测环境没法真的跑手势，
 * 所以按实现断言（和上面一样直接读 node_modules 的产物）——补丁丢了就红。
 */
function readToolkitFile(relative: string) {
  return fs.readFileSync(
    path.join(process.cwd(), 'node_modules/react-native-zoom-toolkit', relative),
    'utf8',
  );
}

describe('Gallery 下拉 / 方向锁（补丁后）', () => {
  const source = readToolkitFile('src/components/gallery/GalleryGestureHandler.tsx');
  const compiled = readToolkitFile('lib/module/components/gallery/GalleryGestureHandler.js');

  it.each([
    ['TS 源码', source],
    ['lib/module 产物', compiled],
  ])('%s：方向按实际位移锁轴，不再用起手速度猜', (_name, code) => {
    // 起手速度是噪声很大的瞬时值：横滑起手带一点下压就会被判成下拉，
    // 整条横向手势被库里 `translate.x = 100` 的判定吞掉（左右滑不动）。
    expect(code).not.toMatch(/isVerticalPan/);
    expect(code).toMatch(/PAN_AXIS_LOCK_DISTANCE/);
    expect(code).toContain('movedY > movedX');
    // 锁轴前可能已经推偏了横向 scroll，进入下拉时要回到当前页
    expect(code).toMatch(/scroll\.value = getScrollPosition\(/);
  });

  it.each([
    ['TS 源码', source],
    ['lib/module 产物', compiled],
  ])('%s：下拉只跟手向下', (_name, code) => {
    expect(code).toContain('Math.max(0, e.translationY)');
  });

  it.each([
    ['TS 源码', source],
    ['lib/module 产物', compiled],
  ])('%s：手势被取消时（onFinalize）也要收尾，不能卡在下拉一半', (_name, code) => {
    // RNGH 在手势被取消时只回调 onFinalize、不回调 onEnd
    expect(code).toMatch(/onFinalize/);
    expect(code).toMatch(/if \(isPullingVertical\.value && !pullHandled\.value\)/);
    // 每次手势开始都要把标志位清干净，否则第二次下拉的"松手"不会再触发回调
    expect(code).toMatch(/pullHandled\.value = false/);
    expect(code).toMatch(/pullReleased\.value = false/);
  });
});

describe('捏合后的手势开关（补丁后）', () => {
  it.each([
    ['TS 源码', 'src/commons/hooks/usePinchCommons.ts'],
    ['lib/module 产物', 'lib/module/commons/hooks/usePinchCommons.js'],
  ])('%s：回弹动画被打断也要恢复手势', (_name, relative) => {
    const code = readToolkitFile(relative);
    // 原版只在 finished 时恢复，捏合后紧接着双击会让开关永久停在 false，预览再也滑不动
    expect(code).toMatch(/scale\.value = withTiming\(toScale[\s\S]{0,200}switchGesturesState, true/);
    expect(code).not.toMatch(/if \(finished\) \{\s*\n\s*scheduleOnRN\(switchGesturesState, true\)/);
  });
});
