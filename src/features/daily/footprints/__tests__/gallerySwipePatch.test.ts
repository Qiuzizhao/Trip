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
